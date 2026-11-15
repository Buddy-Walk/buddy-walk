import { resolveVerifiedTargetHeading } from "../utils/lastMetersNavigation";
import type { LatLng } from "./googleMaps";
import type { LastMetersTrial } from "./lastMetersTrial";
import type { StreetViewMetadata } from "./streetViewPanorama";
import { buildEntranceVisionRequest, requestEntranceVision, unknownAssessment, type EntranceAssessment } from "./lastMetersEntranceVision";
import { withinEntranceBudget } from "./lastMetersPanoramaBudget";
export { parseEntranceAssessment } from "./lastMetersEntranceVision";
export type { EntranceAssessment, EntranceVisibility } from "./lastMetersEntranceVision";
export { withinEntranceBudget } from "./lastMetersPanoramaBudget";

export interface OcclusionOptions {}

interface Observation extends EntranceAssessment {
  panoId?: string;
  date?: string;
  camera?: LatLng;
  mapHeading: number;
  source: "selected_panorama" | "historical";
  storefrontEvidence: "panorama_match" | "historical_assessment" | "unverified";
  entranceVerified: boolean;
}

interface AssessmentInput {
  placeId: string;
  placeName: string;
  target: LatLng;
  photo: string;
  deadline: number;
  options: OcclusionOptions;
  original: StreetViewMetadata;
  /** Shared search IDs also include rejected cameras that must not be relabeled as history. */
  seenPanoramas?: ReadonlySet<string>;
}

/** One Trial's experimental entrance evidence; historical observations never verify a current door. */
export class LastMetersEntranceAssessment {
  private readonly startedAt = Date.now();
  private apiRequests = 0;
  private currentPhotoContradiction = false;
  readonly current: Observation[] = [];
  readonly historical: Observation[] = [];
  readonly examined: { panoId?: string; date?: string }[] = [];
  readonly historicalAttempts: { panoId: string; date: string; outcome: string }[] = [];
  historicalStatus = "not_requested";
  failureReason: string | undefined;
  currentVerified = false;
  verifiedHeading: number | undefined;

  constructor(private readonly input: AssessmentInput) {}

  private async assess(views: { heading: number; base64: string }[], date: string | undefined, historical: boolean): Promise<EntranceAssessment> {
    const request = buildEntranceVisionRequest(this.input.placeName, this.input.photo, views, date, historical);
    return withinEntranceBudget(this.input.deadline, async (signal, timeout) => {
      this.apiRequests++;
      return requestEntranceVision(request, signal, timeout);
    });
  }

  async assessCurrent(
    panorama: { metadata: StreetViewMetadata; tiles: { heading: number; base64: string }[] },
    expectedHeading: number,
    storefrontHeading: number | null,
  ): Promise<boolean> {
    let assessment = unknownAssessment();
    try { assessment = await this.assess(panorama.tiles, panorama.metadata.date, false); }
    catch { this.failureReason = "current_assessment_failed_or_timed_out"; }
    this.currentPhotoContradiction ||= assessment.photoEntrance === "OCCLUDED" || assessment.appearanceChanged;
    this.currentVerified = !this.currentPhotoContradiction && storefrontHeading !== null && assessment.storefrontMatches
      && assessment.panoramaEntrance === "VISIBLE" && assessment.photoEntrance === "VISIBLE" && assessment.sameEntrance
      && resolveVerifiedTargetHeading(assessment.entranceHeading, expectedHeading) !== null;
    this.current.push({
      ...assessment, panoId: panorama.metadata.pano_id, date: panorama.metadata.date, camera: panorama.metadata.location,
      mapHeading: expectedHeading, source: "selected_panorama",
      storefrontEvidence: storefrontHeading !== null ? "panorama_match" : "unverified", entranceVerified: this.currentVerified,
    });
    this.verifiedHeading = this.currentVerified ? assessment.entranceHeading! : undefined;
    return this.currentVerified;
  }

  /** Do not restore a previous match after contradictory evidence in the same live photo. */
  restoreVerified(panoId: string | undefined): boolean {
    this.currentVerified = !this.currentPhotoContradiction && this.current.some(o => o.panoId === panoId && o.entranceVerified);
    return this.currentVerified;
  }

  record(trial: LastMetersTrial, additionalPanoramaRequests: number): void {
    trial.step({ name: "entrance_assessment", prompt: "Experimental entrance evidence. Historical evidence cannot authorize a current turn.",
      model: "occlusion-assessment-v1", success: this.currentVerified,
      durationMs: Math.max(0, Date.now() - this.startedAt),
      response: JSON.stringify({
        occlusionDetected: this.current.some(o => o.panoramaEntrance === "OCCLUDED" || o.photoEntrance === "OCCLUDED"),
        originalPanorama: this.input.original.pano_id, originalDate: this.input.original.date,
        examinedPanoramas: this.examined,
        observations: this.current, historicalObservations: this.historical,
        historicalAttempts: this.historicalAttempts,
        historicalProvider: "unavailable",
        historicalStatus: this.historicalStatus,
        entranceVerified: this.currentVerified, entranceEvidence: this.currentVerified ? "panorama_and_current_photo" : "unverified",
        failureReason: this.currentVerified ? undefined : this.failureReason
          ?? (this.current.length ? "current_entrance_unverified" : "entrance_not_evaluated"),
        additionalApiRequests: this.apiRequests + additionalPanoramaRequests,
      }),
    });
  }
}
