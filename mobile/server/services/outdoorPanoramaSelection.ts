import axios from "axios";
import sharp from "sharp";
import { outdoorPanoramaRejection, OutdoorPanoramaMetadata } from "../utils/outdoorPanorama";

export type SceneVerdict = "outdoor" | "indoor" | "uncertain";
export interface PanoramaAttempt {
  panoId?: string;
  status: string;
  reason: string;
  distanceMeters?: number;
}
export type SceneClassifier = (images: string[], timeoutMs: number) => Promise<SceneVerdict>;
export type PanoramaAudit = (attempt: PanoramaAttempt) => void;
export interface PanoramaSearchBudget { seen: Set<string>; deadline: number }
export interface SelectedPanorama extends OutdoorPanoramaMetadata { date?: string }

/**
 * Accept only explicit indoor/outdoor classifier verdicts; preserve every other answer as
 * uncertain.
 */
export function parseSceneVerdict(value: string): SceneVerdict {
  const verdict = value.trim().toLowerCase();
  return verdict === "outdoor" || verdict === "indoor" ? verdict : "uncertain";
}

/**
 * Search bounded nearby Street View metadata probes, deduplicate panorama IDs, validate preview
 * images, and accept only confidently outdoor imagery within the shared deadline.
 */
export async function selectOutdoorPanorama(
  lat: number, lng: number, apiKey: string, classify: SceneClassifier,
  audit: PanoramaAudit = () => { /* Allow callers that do not need an audit hook to use the same validated panorama search. */ },
  budget?: PanoramaSearchBudget,
): Promise<{ metadata: SelectedPanorama; attempts: PanoramaAttempt[] }> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) {
    throw new Error("Panorama lookup requires valid supported coordinates.");
  }
  const attempts: PanoramaAttempt[] = [];
  const seen = budget?.seen ?? new Set<string>();
  const deadline = budget?.deadline ?? Date.now() + 45_000;
  /** Limit each network call to the remaining search budget, capped at ten seconds. */
  const remaining = () => Math.max(1, Math.min(10_000, deadline - Date.now()));
  /**
   * Append and publish every panorama attempt so rejected or uncertain imagery remains
   * diagnosable.
   */
  const record = (attempt: PanoramaAttempt) => {
    attempts.push(attempt);
    audit(attempt);
    console.info("[panorama-validation]", JSON.stringify(attempt));
  };
  const latOffset = 30 / 111_320;
  const lngOffset = latOffset / Math.cos(lat * Math.PI / 180);
  const probes = [[lat, lng], [lat + latOffset, lng], [lat, lng + lngOffset],
    [lat - latOffset, lng], [lat, lng - lngOffset]];
  for (const [probeLat, probeLng] of probes) {
    if (seen.size >= 3 || Date.now() >= deadline) break;
    let panoId: string | undefined;
    try {
      const { data: metadata } = await axios.get<SelectedPanorama>(
        "https://maps.googleapis.com/maps/api/streetview/metadata",
        { params: { location: `${probeLat},${probeLng}`, radius: 40, source: "outdoor", key: apiKey }, timeout: remaining() },
      );
      panoId = metadata.pano_id;
      const rejection = outdoorPanoramaRejection(metadata);
      if (rejection) { record({ panoId, status: "metadata_rejected", reason: rejection }); continue; }
      if (seen.has(panoId!)) { record({ panoId, status: "duplicate", reason: "Already evaluated this panorama." }); continue; }
      seen.add(panoId!);
      const north = (metadata.location!.lat - lat) * 111_320;
      const east = (metadata.location!.lng - lng) * 111_320 * Math.cos(lat * Math.PI / 180);
      const distanceMeters = Math.round(Math.hypot(north, east));
      if (distanceMeters > 75) {
        record({ panoId, status: "too_far", reason: "Camera is more than 75 meters from the requested location.", distanceMeters });
        continue;
      }
      // Four 90-degree views cover the full horizon, unlike narrow matching tiles.
      const images = await Promise.all([0, 90, 180, 270].map(async heading => {
        // Download one preview direction from the candidate panorama and require usable image
        // dimensions before scene classification.
        const response = await axios.get("https://maps.googleapis.com/maps/api/streetview", {
          params: { size: "640x640", pano: panoId, heading, fov: 90, pitch: 0, source: "outdoor", return_error_code: true, key: apiKey },
          responseType: "arraybuffer", timeout: remaining(),
        });
        const bytes = Buffer.from(response.data);
        const info = await sharp(bytes).metadata();
        if ((info.width ?? 0) < 320 || (info.height ?? 0) < 320) throw new Error("Unusable preview");
        return `data:image/jpeg;base64,${bytes.toString("base64")}`;
      }));
      if (Date.now() >= deadline) break;
      const verdict = await classify(images, remaining());
      if (Date.now() >= deadline) break;
      const accepted = verdict === "outdoor";
      record({ panoId, status: accepted ? "accepted" : "scene_rejected", distanceMeters,
        reason: accepted ? "Visual check classified the camera surroundings as outdoor." : `Visual check: ${verdict === "indoor" ? "indoor" : "uncertain"}.` });
      if (accepted) return { metadata, attempts };
    } catch {
      // Do not persist provider errors containing signed image URLs or API keys.
      record({ panoId, status: "validation_error", reason: "Metadata, preview download, or visual classification failed or timed out." });
    }
  }
  if (Date.now() >= deadline) record({ status: "timeout", reason: "Outdoor validation reached its 45-second limit." });
  throw Object.assign(new Error("No nearby panorama passed outdoor visual validation."), {
    code: "STREET_VIEW_NO_VALIDATED_OUTDOOR_PANORAMA", attempts,
  });
}
