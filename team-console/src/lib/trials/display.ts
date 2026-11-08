// Text the Trials pages show, ported from the old dashboard. Dates use the
// reader's locale and time zone, so only call these in the browser.
import type { PanoramaMode, RetryHistoryEntry, Trial } from "./schema";

export const MISSING = "-";

/** The pipeline version shown for a Trial logged before versions were recorded. */
export const UNVERSIONED = "legacy-unversioned";

export const PANORAMA_MODE_LABELS: Record<PanoramaMode, string> = {
  fresh: "Fresh panorama",
  original: "Original panorama",
};

const SOURCE_LABELS: Record<string, string> = {
  google_places: "Google Places",
  google_building_entrances: "Google building entrances",
  street_view_panorama: "Street View panorama",
  street_view_reference: "Street View destination image",
  street_view_sign_closeup: "Street View sign close-up",
  phone_gps: "Phone GPS",
  phone_compass: "Phone compass",
};

const validDate = (value: string | undefined) => {
  const date = new Date(value ?? "");
  return value && !Number.isNaN(date.getTime()) ? date : undefined;
};

export function formatDate(value: string | undefined): string {
  return validDate(value)?.toLocaleString() ?? MISSING;
}

export function formatShortDate(value: string | undefined): string {
  return (
    validDate(value)?.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }) ?? MISSING
  );
}

export const trialTime = (trial: Pick<Trial, "serverTs" | "createdAt">) =>
  trial.serverTs || trial.createdAt;

export const trialName = (trial: Pick<Trial, "destinationPlaceName" | "destination">) =>
  trial.destinationPlaceName || trial.destination;

export function formatMeters(meters: number | undefined, missing = MISSING): string {
  return meters != null ? `${Math.round(meters)} m` : missing;
}

export function formatRuntime(durationMs: number | undefined): string {
  return typeof durationMs === "number" && Number.isFinite(durationMs)
    ? `${Math.round(durationMs)} ms`
    : MISSING;
}

/** A git hash shortened the usual way; other markers such as local-unversioned stay whole. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{12,}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

/** Only data URLs are stored images; anything else is a placeholder. */
export function storedImage(value: string | undefined): string | undefined {
  return value?.startsWith("data:") ? value : undefined;
}

export const panoramaModeText = (mode: PanoramaMode | undefined) =>
  PANORAMA_MODE_LABELS[mode ?? "fresh"].toLowerCase();

/** How accurate the phone's GPS was, in the bands calculateLastMetersConfidence weighs. */
export function gpsBand(meters: number): "good" | "ok" | "poor" {
  return meters <= 15 ? "good" : meters <= 40 ? "ok" : "poor";
}

export interface ResolvedDestination {
  requested: string;
  /** The place and address Google resolved, or undefined when it resolved nothing. */
  resolved: string | undefined;
  /** Google resolved a differently named place, such as another branch. */
  mismatch: boolean;
}

export function resolvedDestination(trial: Trial): ResolvedDestination {
  const requested = trial.destination || "";
  const placeName = trial.destinationPlaceName || "";
  const address = trial.destinationPlaceAddress || "";
  return {
    requested: requested || placeName || MISSING,
    resolved: placeName || address ? [placeName, address].filter(Boolean).join(" · ") : undefined,
    mismatch: Boolean(
      placeName && requested && !placeName.toLowerCase().includes(requested.toLowerCase()),
    ),
  };
}

export function noPanoramaReason(trial: Trial): string {
  const distance =
    trial.destinationDistanceMeters != null ? Math.round(trial.destinationDistanceMeters) : null;
  if (trial.testScenario === "question_routed") {
    return "Not a Last Meters Trial: the input was a question and was answered by the question flow.";
  }
  if (trial.testScenario === "no_panorama") {
    return `No usable outdoor panorama was obtained (${trial.panoramaStatus || "unavailable"}). This can mean imagery was missing, rejected, or could not be validated; see the validation attempts.`;
  }
  if (trial.panoramaSource === "background" && trial.panoramaStatus) {
    return `The review panorama could not be saved: ${trial.panoramaStatus}.`;
  }
  if (
    (trial.navigationMode === "approach" || trial.navigationMode === "aligned") &&
    trial.dataSources
  ) {
    return "The review panorama is saved after the answer is sent. Reopen this Trial in a few seconds.";
  }
  if (trial.navigationMode === "approach" || trial.testScenario === "test_b_approach") {
    return `Panorama skipped: destination resolved ${distance !== null ? `${distance} m` : ">250 m"} away (approach mode). Check the resolved place address - Google may have picked a different branch, or GPS drifted.`;
  }
  if (trial.navigationMode === "aligned" || trial.testScenario === "heading_aligned") {
    return `Panorama skipped: user already facing the destination bearing ${distance !== null ? `${distance} m away` : ""} (aligned mode).`;
  }
  if (
    trial.error === "destination_not_verified" ||
    trial.testScenario === "destination_not_verified"
  ) {
    return "Panorama skipped: Google Places could not verify the destination nearby.";
  }
  return "No panorama: the run stopped before or during Street View download - check the failed stage below.";
}

export interface DataSourceFacts {
  used: string;
  imagery: string | undefined;
  target: string;
  allowance: string;
  openNow: string;
  searchedAs: string | undefined;
}

export function dataSourceFacts(trial: Trial): DataSourceFacts {
  const imagery: string[] = [];
  if (trial.panoramaDate) {
    imagery.push(
      `captured ${trial.panoramaDate}${
        trial.panoramaAgeYears != null && trial.panoramaAgeYears >= 3
          ? ` (about ${Math.floor(trial.panoramaAgeYears)} years old)`
          : ""
      }`,
    );
  }
  if (trial.panoramaCopyright) imagery.push(trial.panoramaCopyright);
  if (trial.panoId) imagery.push(`pano id ${trial.panoId}`);
  if (trial.panoramaSource === "background")
    imagery.push("saved after the answer, for review only");

  let target =
    trial.entranceSource === "geocoding_entrance"
      ? "Nearest building entrance from Google Geocoding"
      : trial.entranceSource === "places_pin"
        ? "Google Places map pin"
        : MISSING;
  if (trial.besideBuilding) target += " (user is beside the building)";

  let openNow =
    trial.destinationOpenNow === true
      ? "Open"
      : trial.destinationOpenNow === false
        ? "Closed"
        : "Not listed";
  if (trial.destinationBusinessStatus && trial.destinationBusinessStatus !== "OPERATIONAL") {
    openNow += ` (${trial.destinationBusinessStatus})`;
  }

  return {
    used:
      (trial.dataSources ?? [])
        .map((source) => (Object.hasOwn(SOURCE_LABELS, source) ? SOURCE_LABELS[source] : source))
        .join(", ") || "Not recorded (Trial predates source logging)",
    imagery: imagery.length ? imagery.join(" · ") : undefined,
    target,
    allowance:
      trial.gpsAllowanceMeters != null
        ? `${formatMeters(trial.gpsAllowanceMeters)}${
            trial.exactGateWidened ? " (the allowance is what let this Trial into exact mode)" : ""
          }`
        : MISSING,
    openNow,
    searchedAs:
      trial.destinationQuery && trial.destinationQuery !== trial.destination
        ? `${trial.destinationQuery} (from "${trial.destination ?? ""}")`
        : undefined,
  };
}

/** A retry's place among its original's retries, counting from 1, or undefined. */
export function retryNumber(history: { retries: RetryHistoryEntry[] }, trialId: string) {
  const index = history.retries.findIndex((retry) => retry.id === trialId);
  return index >= 0 ? index + 1 : undefined;
}
