import type { textRequestBody } from "../types";
import { RECAPTURE_MESSAGE } from "../../src/utils/lastMetersSafety";
import type { LastMetersGuidancePolicy, LastMetersGuidanceContext } from "../utils/lastMetersGuidancePolicy";
import type { WalkingEvidence } from "../utils/lastMetersPolicy";
import {
  LAST_METERS_PIPELINE_VERSION,
  buildReplayInput,
  type LastMetersRequestInput,
  type ReplayInput,
} from "../utils/lastMetersReplay";
import {
  streetViewImageryAgeYears,
  type compareCompassAndPanoramaHeadings,
  type ExactModeGate,
  type LastMetersConfidence,
  type LastMetersTestScenario,
} from "../utils/lastMetersNavigation";
import type { lastMetersTestStepInterface } from "../database/models/lastMetersTestLog";
import type { LatLng } from "./googleMaps";
import type { DestinationNotVerifiedError, VerifiedNearbyDestination } from "./verifiedDestination";
import type { PanoramaAttempt } from "./outdoorPanoramaSelection";
import type { processPanoramaTiles } from "./streetViewPanorama";
import { compressUserPhoto, lastMetersTestLogService } from "./lastMetersTestLog";
import type { LastMetersRunOptions, LastMetersRunResult } from "./lastMetersService";

export type TrialStep = lastMetersTestStepInterface;

/** What every step returns. */
export type StepResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "exit"; result: LastMetersRunResult };

/** Where guidance aims: the nearest listed building entrance, or else the Verified destination's map pin. */
export interface GuidanceTarget {
  source: "places_pin" | "geocoding_entrance";
  location: LatLng;
  /** From the user to `location`, so to the entrance once one is found, not to the map pin. */
  distanceMeters: number;
  /** Set when Google lists the building's outline. */
  besideBuilding?: boolean;
}

/** The phone compass compared with the Verified destination's bearing from the user. */
export interface HeadingAlignment {
  destinationBearing: number;
  differenceDegrees?: number;
  aligned?: boolean;
}

/** The destination-focused Street View photo, or why it was skipped. */
export interface DestinationReference {
  photo?: string;
  date?: string;
  status: string;
}

/** What a Last Meters run learned, one object per step's result. */
export interface TrialFacts {
  /** The place name searched, after a question lead-in is removed. */
  destinationQuery: string;
  navigationMode?: "approach" | "exact" | "aligned";
  testScenario?: LastMetersTestScenario;
  verifiedDestination?: VerifiedNearbyDestination;
  /** What Google returned when no destination could be verified. */
  destinationNotVerified?: DestinationNotVerifiedError;
  entrance?: GuidanceTarget;
  headingAlignment?: HeadingAlignment;
  gate?: ExactModeGate;
  /** Every panorama tried; the run adds to it as it searches. */
  panoramaValidation: PanoramaAttempt[];
  panorama?: Pick<Awaited<ReturnType<typeof processPanoramaTiles>>, "metadata" | "tiles">;
  /** The status saved when no panorama could be downloaded. */
  missingPanoramaStatus?: string;
  /** The panorama's tiles assembled into one image. */
  panoramaPhoto?: string;
  headingComparison?: ReturnType<typeof compareCompassAndPanoramaHeadings>;
  /** The user's heading: the compared heading, then the guidance heading once the turn checks pass. */
  currentHeading?: number;
  destinationReference?: DestinationReference;
  destinationReferenceUsed: boolean;
  signText?: { text: string; matched: boolean };
  panoramaTargetHeading?: number;
  /** A heading conflict knows only that confidence is low. */
  confidence?: Pick<LastMetersConfidence, "level"> & Partial<LastMetersConfidence>;
  walkingEvidence: WalkingEvidence;
  safetyReasons: string[];
}

/** How a run ended, saved alongside the facts. */
interface TrialOutcome {
  finalOutput?: string;
  success: boolean;
  error?: string;
  targetHeading?: number;
  turnInstruction?: string;
}

/** The saved row before the run's kind and outcome are added. */
type TrialRow = Omit<Parameters<typeof lastMetersTestLogService.record>[0], "success">;

/**
 * The Trial one Last Meters run records. Steps note what they learn as whole
 * objects, and the Trial turns them into the flat saved row when the run ends.
 */
export class LastMetersTrial {
  readonly startedAt = Date.now();
  private readonly request: LastMetersRequestInput;
  private readonly image: string;
  private readonly options: LastMetersRunOptions;
  private readonly policy: LastMetersGuidancePolicy;
  private readonly replayInput: ReplayInput;
  private readonly steps: TrialStep[] = [];
  private readonly dataSources = new Set<string>();
  private activeStage = "destination proximity check";
  private facts: TrialFacts;

  constructor(input: {
    request: LastMetersRequestInput;
    image: string;
    options: LastMetersRunOptions;
    policy: LastMetersGuidancePolicy;
  }) {
    this.request = input.request;
    this.image = input.image;
    this.options = input.options;
    this.policy = input.policy;
    this.replayInput = input.options.retry?.replayInput ?? buildReplayInput(input.request, input.image, this.startedAt);
    this.facts = {
      destinationQuery: input.request.destination,
      panoramaValidation: [],
      destinationReferenceUsed: false,
      walkingEvidence: { verified: false, reason: "walking_route_not_checked" },
      safetyReasons: [],
    };
  }

  /** Names the stage for the 502 message. */
  stage(name: string): void {
    this.activeStage = name;
  }

  /** Logs one step. */
  step(step: TrialStep): void {
    this.steps.push(step);
  }

  /** Adds a data source. */
  source(name: string): void {
    this.dataSources.add(name);
  }

  /** Records whole objects, e.g. { verifiedDestination }, { panorama }. */
  note(facts: Partial<TrialFacts>): void {
    this.facts = { ...this.facts, ...facts };
  }

  /** The guidance policy's message for a withheld turn, given what the run has learned. */
  withheldMessage(reasons: string[], message: string): string {
    return this.policy.withheldMessage(reasons, message, this.row());
  }

  /** Ends the run with an answer; mode and scenario come from the noted facts. */
  async answer(
    body: Record<string, unknown>,
    outcome: TrialOutcome,
    reviewPanorama?: (testLogId: string | undefined) => Promise<void>,
  ): Promise<LastMetersRunResult> {
    const testLogId = await this.record(outcome);
    return this.respond(200, {
      output: outcome.finalOutput,
      testLogId,
      mode: this.facts.navigationMode,
      testScenario: this.facts.testScenario,
      ...body,
    }, testLogId, reviewPanorama?.(testLogId));
  }

  /** Ends the run without a precise turn, saying why in the guidance policy's words. */
  async withhold(reasons: string[], message = RECAPTURE_MESSAGE): Promise<LastMetersRunResult> {
    const safetyReasons = [...new Set(reasons)];
    this.note({ safetyReasons });
    const output = this.withheldMessage(safetyReasons, message);
    this.step({ name: "turn_safety_gate", prompt: "Require sufficient evidence before any precise turn.",
      response: safetyReasons.join("; "), model: "deterministic-safety-policy", success: false });
    const testLogId = await this.record({ finalOutput: output, success: false, error: "turn_withheld" });
    return this.respond(200, { output, testLogId, warning: "turn_withheld", safetyReasons,
      guidanceKind: "withheld", targetHeading: null, pipelineVersion: LAST_METERS_PIPELINE_VERSION }, testLogId);
  }

  /** Ends the run with a 502 naming the stage that failed. */
  async fail(caught: unknown): Promise<LastMetersRunResult> {
    const error = caught as { status?: unknown; response?: { status?: unknown }; code?: unknown; message?: string } | undefined;
    const upstreamStatus = error?.status ?? error?.response?.status;
    const failureReason =
      typeof upstreamStatus === "number"
        ? `upstream returned HTTP ${upstreamStatus}`
        : typeof error?.code === "string"
          ? error.code
          : "unexpected backend error";
    const clientError = `Last Meters failed during ${this.activeStage}: ${failureReason}.`;
    console.error("❌ Last Meters request failed:", {
      stage: this.activeStage,
      status: upstreamStatus,
      code: error?.code,
      message: error?.message,
    });
    const testLogId = await this.record({
      success: false,
      error: error?.message ?? "Last meters calculation failed.",
    });
    return this.respond(502, { error: clientError }, testLogId);
  }

  /** Ends the run by handing a question to the Question service. */
  async question(textRequest: textRequestBody): Promise<LastMetersRunResult> {
    const testLogId = await this.record({
      finalOutput: "Answered by the question answering flow.",
      success: true,
    });
    return { kind: "question", testLogId, textRequest };
  }

  private respond(
    status: number,
    body: Record<string, unknown>,
    testLogId: string | undefined,
    reviewPanorama?: Promise<void>,
  ): LastMetersRunResult {
    return { kind: "response", status, body, testLogId, reviewPanorama };
  }

  private async record(outcome: TrialOutcome): Promise<string | undefined> {
    const { retry, requestPath } = this.options;
    return lastMetersTestLogService.record({
      ...this.row(),
      // A retry links to the original and reuses its stored photo.
      ...(retry
        ? {
            runKind: "replay" as const,
            retryOf: retry.retryOf,
            retryPanoramaMode: retry.panoramaMode,
            retryDefaultsApplied: retry.defaultsApplied,
          }
        : {
            runKind: "field" as const,
            requestPath,
            userPhoto: await compressUserPhoto(this.image),
          }),
      ...outcome,
    });
  }

  /** The flat saved row, built from the noted facts. */
  private row(): TrialRow & LastMetersGuidanceContext {
    const { request, facts } = this;
    const place = facts.verifiedDestination;
    const metadata = facts.panorama?.metadata;
    const comparison = facts.headingComparison;
    const entrance = facts.entrance;
    const listedEntrance = entrance?.source === "geocoding_entrance" ? entrance.location : undefined;
    return {
      replayInput: this.replayInput,
      safetyReasons: facts.safetyReasons,
      walkingEvidence: facts.walkingEvidence,
      panoramaTargetHeading: facts.panoramaTargetHeading,
      confidenceMethod: "heuristic-not-calibrated",
      destination: request.destination,
      destinationQuery: facts.destinationQuery,
      lat: request.lat,
      lng: request.lng,
      panoramaPhoto: facts.panoramaPhoto,
      panoramaDate: metadata?.date,
      panoramaStatus: metadata?.status ?? facts.missingPanoramaStatus,
      panoramaValidation: facts.panoramaValidation,
      panoramaSource: facts.panoramaPhoto ? "pipeline" : undefined,
      panoId: metadata?.pano_id,
      panoramaCopyright: metadata?.copyright,
      panoramaAgeYears: metadata ? streetViewImageryAgeYears(metadata.date) : undefined,
      panoramaHeadings: facts.panorama?.tiles.map(tile => tile.heading) ?? [],
      placeCandidates: place?.placeCandidates ?? facts.destinationNotVerified?.placeCandidates,
      placesSearches: place?.placesSearches ?? facts.destinationNotVerified?.placesSearches,
      gpsAllowanceMeters: facts.gate?.allowanceMeters,
      exactGateWidened: facts.gate?.widened,
      entranceSource: entrance?.source,
      entranceLat: listedEntrance?.lat,
      entranceLng: listedEntrance?.lng,
      besideBuilding: entrance?.besideBuilding,
      destinationOpenNow: place?.openNow,
      destinationBusinessStatus: place?.businessStatus,
      signText: facts.signText?.text,
      signTextMatched: facts.signText?.matched,
      dataSources: [...this.dataSources],
      destinationPhoto: facts.destinationReference?.photo,
      destinationPhotoDate: facts.destinationReference?.date,
      destinationPhotoStatus: facts.destinationReference?.status,
      destinationPlaceName: place?.placeName,
      destinationPlaceAddress: place?.placeAddress,
      destinationTypes: place?.types ?? [],
      destinationDistanceMeters: entrance?.distanceMeters ?? place?.distanceMeters,
      gpsAccuracyMeters: request.gpsAccuracyMeters,
      compassAccuracyLevel: request.compassAccuracyLevel,
      destinationBearing: facts.headingAlignment?.destinationBearing,
      deviceHeading: request.deviceHeading,
      headingDifferenceDegrees: facts.headingAlignment?.differenceDegrees,
      headingAligned: facts.headingAlignment?.aligned,
      compassHeading: comparison?.compassHeading ?? undefined,
      panoramaMatchedHeading: comparison?.panoramaMatchedHeading ?? undefined,
      headingComparisonDifference: comparison?.differenceDegrees,
      headingComparisonAgrees: comparison?.agrees,
      confidenceScore: facts.confidence?.score,
      confidenceLevel: facts.confidence?.level,
      confidenceReasons: facts.confidence?.reasons,
      destinationReferenceUsed: facts.destinationReferenceUsed,
      navigationMode: facts.navigationMode,
      testScenario: facts.testScenario,
      currentHeading: facts.currentHeading,
      steps: this.steps,
      latencyMs: Date.now() - this.startedAt,
    };
  }
}
