import { resolveVerifiedTargetHeading } from "../utils/lastMetersNavigation";
import type { LatLng } from "./googleMaps";
import { buildEntranceVisionRequest, requestEntranceVision, type EntranceAssessment } from "./lastMetersEntranceVision";
import type { PanoramaSearchBudget } from "./lastMetersPanoramaBudget";
import type { LastMetersTrial } from "./lastMetersTrial";
import type { StreetViewMetadata } from "./streetViewPanorama";
export { parseEntranceAssessment } from "./lastMetersEntranceVision";
export type { EntranceAssessment, EntranceVisibility } from "./lastMetersEntranceVision";

interface Observation extends EntranceAssessment {
  panoId?: string;
  date?: string;
  camera?: LatLng;
  mapHeading: number;
  source: "selected_panorama";
  storefrontEvidence: "panorama_match" | "unverified";
  entranceVerified: boolean;
}

interface AssessmentInput {
  placeName: string;
  photo: string;
  budget: PanoramaSearchBudget;
  original: StreetViewMetadata;
}

/** Current entrance evidence across one Trial’s candidate cameras. */
export class LastMetersEntranceAssessment {
  private readonly startedAt = Date.now();
  private currentPhotoContradiction = false;
  readonly current: Observation[] = [];
  readonly examined: { panoId?: string; date?: string }[] = [];
  failureReason?: "search_budget_exhausted" | "panorama_matching_failed";
  currentVerified = false;
  verifiedHeading: number | undefined;

  private readonly requestsAtFirstCamera: number;

  constructor(private readonly input: AssessmentInput) {
    this.requestsAtFirstCamera = input.budget.apiRequests;
  }

  examine(metadata: StreetViewMetadata): void {
    this.currentVerified = false;
    this.verifiedHeading = undefined;
    this.examined.push({ panoId: metadata.pano_id, date: metadata.date });
  }

  async assessCurrent(
    panorama: { metadata: StreetViewMetadata; tiles: { heading: number; base64: string }[] },
    expectedHeading: number,
    storefrontHeading: number | null,
  ): Promise<boolean> {
    const request = buildEntranceVisionRequest(this.input.placeName, this.input.photo, panorama.tiles, panorama.metadata.date);
    const assessment = await requestEntranceVision(request, this.input.budget);
    this.currentPhotoContradiction ||= assessment.photoEntrance === "OCCLUDED"
      || assessment.photoEntrance === "NOT_VISIBLE" || assessment.appearanceChanged;
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
    const retained = this.currentPhotoContradiction || !panoId ? undefined
      : this.current.find(observation => observation.panoId === panoId && observation.entranceVerified);
    this.currentVerified = retained !== undefined;
    this.verifiedHeading = retained?.entranceHeading ?? undefined;
    return this.currentVerified;
  }

  record(trial: LastMetersTrial): void {
    trial.step({ name: "entrance_assessment", prompt: "Assess doorway visibility in the selected panorama and the current photo.",
      model: "occlusion-assessment-v1", success: this.currentVerified,
      durationMs: Math.max(0, Date.now() - this.startedAt),
      response: JSON.stringify({
        occlusionDetected: this.current.some(observation => observation.panoramaEntrance === "OCCLUDED" || observation.photoEntrance === "OCCLUDED"),
        originalPanorama: this.input.original.pano_id, originalDate: this.input.original.date,
        examinedPanoramas: this.examined,
        observations: this.current,
        entranceVerified: this.currentVerified, entranceEvidence: this.currentVerified ? "panorama_and_current_photo" : "unverified",
        failureReason: this.currentVerified ? undefined : this.failureReason
          ?? (this.current.length ? "current_entrance_unverified" : "entrance_not_evaluated"),
        additionalApiRequests: this.input.budget.apiRequests - this.requestsAtFirstCamera,
      }),
    });
  }
}
