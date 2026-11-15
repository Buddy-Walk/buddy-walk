import { resolveVerifiedTargetHeading, snapLastMetersHeading } from "../utils/lastMetersNavigation";
import { calculateHeading, type LatLng } from "./googleMaps";
import type { LastMetersTrial } from "./lastMetersTrial";
import type { StreetViewMetadata } from "./streetViewPanorama";
import { buildEntranceVisionRequest, requestEntranceVision, unknownAssessment, type EntranceAssessment } from "./lastMetersEntranceVision";
import { withinEntranceBudget } from "./lastMetersPanoramaBudget";
export { parseEntranceAssessment } from "./lastMetersEntranceVision";
export type { EntranceAssessment, EntranceVisibility } from "./lastMetersEntranceVision";
export { withinEntranceBudget } from "./lastMetersPanoramaBudget";
import { capturePeriod, selectHistoricalPanoramaCandidates, type HistoricalPanoramaProvider } from "./lastMetersHistoricalPanoramas";
export type { HistoricalPanorama, HistoricalPanoramaProvider } from "./lastMetersHistoricalPanoramas";

export interface OcclusionOptions {
  historicalProvider?: HistoricalPanoramaProvider;
}

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

  async searchHistory(pinned: boolean): Promise<void> {
    if (this.currentVerified) return;
    if (pinned) { this.historicalStatus = "pinned_retry"; return; }
    const occluded = this.current.some(o => o.storefrontEvidence === "panorama_match"
      && (o.panoramaEntrance === "OCCLUDED" || o.photoEntrance === "OCCLUDED"));
    if (!occluded) { this.historicalStatus = "occlusion_not_established"; return; }
    const provider = this.input.options.historicalProvider;
    if (!provider) { this.historicalStatus = "provider_unavailable"; return; }
    if (Date.now() >= this.input.deadline) { this.historicalStatus = "budget_exhausted"; return; }
    const dates = this.current.map(o => ({ date: o.date, period: capturePeriod(o.date ?? "") }))
      .filter((o): o is { date: string; period: { start: number; end: number } } => !!o.date && !!o.period)
      .sort((a, b) => a.period.start - b.period.start);
    if (!dates.length) { this.historicalStatus = "capture_date_unavailable"; return; }
    try {
      const candidates = await withinEntranceBudget(this.input.deadline, signal => {
        this.apiRequests++;
        return provider.list({ placeId: this.input.placeId, location: this.input.target, before: dates[0].date, maxPeriods: 3, signal });
      });
      const ids = new Set([...this.input.seenPanoramas ?? [], ...this.current.map(o => o.panoId)]);
      const periods: { start: number; end: number }[] = [];
      const eligible = selectHistoricalPanoramaCandidates(candidates, dates[0].period.start, this.input.placeId, this.input.target);
      this.historicalStatus = "no_usable_history";
      for (const { panorama, period } of eligible) {
        if (periods.length >= 3) break;
        if (ids.has(panorama.panoId) || periods.some(p => p.start < period!.end && period!.start < p.end)) continue;
        ids.add(panorama.panoId);
        periods.push(period!);
        const heading = snapLastMetersHeading(calculateHeading(panorama.camera, this.input.target));
        const attempt = { panoId: panorama.panoId, date: panorama.date, outcome: "failed_or_timed_out" };
        this.historicalAttempts.push(attempt);
        const photo = await withinEntranceBudget(this.input.deadline, signal => {
          this.apiRequests++;
          return provider.loadView(panorama, { heading, signal });
        });
        if (typeof photo !== "string" || photo.length > 12_000_000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(photo)) {
          this.failureReason = "historical_image_invalid";
          attempt.outcome = "invalid_image";
          continue;
        }
        const assessment = await this.assess([{ heading, base64: photo }], panorama.date, true);
        // Even a faulty model/adapter cannot promote history into live entrance evidence.
        this.historical.push({ ...assessment, photoEntrance: "UNCERTAIN", sameEntrance: false,
          panoId: panorama.panoId, date: panorama.date, camera: panorama.camera, mapHeading: heading,
          source: "historical", storefrontEvidence: assessment.storefrontMatches ? "historical_assessment" : "unverified", entranceVerified: false });
        this.historicalStatus = "history_inconclusive";
        attempt.outcome = "inconclusive";
        if (assessment.storefrontMatches && assessment.panoramaEntrance === "VISIBLE" && !assessment.appearanceChanged
          && resolveVerifiedTargetHeading(assessment.entranceHeading, heading) !== null) {
          this.historicalStatus = "historical_entrance_only";
          attempt.outcome = "historical_entrance_only";
          break;
        }
      }
    } catch {
      // Provider exception messages may contain credentials or signed URLs.
      this.historicalStatus = "history_failed_or_timed_out";
    }
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
        historicalProvider: this.input.options.historicalProvider
          ? (/^[a-z][a-z0-9_-]{0,63}$/.test(this.input.options.historicalProvider.id)
            ? this.input.options.historicalProvider.id : "server_configured_provider") : "unavailable",
        historicalStatus: this.historicalStatus,
        entranceVerified: this.currentVerified, entranceEvidence: this.currentVerified ? "panorama_and_current_photo" : "unverified",
        failureReason: this.currentVerified ? undefined : this.failureReason
          ?? (this.current.length ? "current_entrance_unverified" : "entrance_not_evaluated"),
        additionalApiRequests: this.apiRequests + additionalPanoramaRequests,
      }),
    });
  }
}
