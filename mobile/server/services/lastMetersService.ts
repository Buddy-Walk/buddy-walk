import { textRequestBody, AppContext } from "../types";
import dotenv from "dotenv";
import { strictLastMetersGuidancePolicy, type LastMetersGuidancePolicy } from "../utils/lastMetersGuidancePolicy";
import type { LastMetersRequestInput, ReplayInput } from "../utils/lastMetersReplay";
import type { RetryPanoramaMode } from "../database/models/lastMetersTestLog";
import type { LastMetersPath } from "../config/lastMetersPaths";
import type { StreetViewMetadata } from "./streetViewPanorama";
import { OpenAIQuestionService } from "./openAIQuestionService";
import { LastMetersTrial } from "./lastMetersTrial";
import { classifyInput } from "./lastMetersInputClassification";
import { findEntrance, verifyDestination } from "./lastMetersDestination";
import { passProximityGate } from "./lastMetersProximityGate";
import { matchPanoramaHeadings, startPanoramaSearch } from "./lastMetersPanoramaMatching";
import { decideTurn, TURN_NOT_VERIFIED_MESSAGE } from "./lastMetersTurnDecision";
import { composeGuidance } from "./lastMetersGuidance";
dotenv.config();

export class LastMetersService {
  /** Answers Last Meters inputs that turn out to be Questions. */
  constructor(
    private readonly questionService: Pick<OpenAIQuestionService, "textRequest"> = new OpenAIQuestionService(),
  ) {}

  /** Use the existing policy by default; a mobile subclass can choose its own field-only policy. */
  protected lastMetersGuidancePolicy(_options: LastMetersRunOptions): LastMetersGuidancePolicy {
    return strictLastMetersGuidancePolicy;
  }

  // --- LAST METERS NAVIGATION PIPELINE ---
  /** Runs Last Meters for an app request and sends the answer. */
  async lastMetersRequest(
    ctx: AppContext,
    request: LastMetersRequestInput,
    image: string,
    requestPath: LastMetersPath,
  ) {
    const result = await this.runLastMeters(request, image, { requestPath });
    if (result.kind === "question") {
      return this.questionService.textRequest(ctx, result.textRequest);
    }
    ctx.res.status(result.status).json(result.body);
  }

  /**
   * The Last Meters pipeline. Records the trial and returns the answer
   * instead of sending it, so dashboard retries can replay a past trial.
   */
  async runLastMeters(
    request: LastMetersRequestInput,
    image: string,
    options: LastMetersRunOptions = {},
  ): Promise<LastMetersRunResult> {
    const guidancePolicy = this.lastMetersGuidancePolicy(options);
    const { lat, lng, deviceHeading, gpsAccuracyMeters, sensors } = request;
    const { retry, pinnedPanorama } = options;
    const trial = new LastMetersTrial({ request, image, options, policy: guidancePolicy });
    // A retry keeps the original's snapshot and judges sensor freshness as of
    // the original request.
    const evaluationTime = retry?.replayInput.receivedAt ?? trial.startedAt;
    const guidanceHeading = guidancePolicy.guidanceHeading(request, evaluationTime);
    const safetyNow = () => evaluationTime + Date.now() - trial.startedAt;
    const turnSensorReasons = () =>
      guidancePolicy.turnSensorReasons(sensors, { lat, lng }, deviceHeading, gpsAccuracyMeters, safetyNow(), evaluationTime);

    // Identify field policy changes separately from the shared pipeline and replay schema versions.
    if (guidancePolicy.version) trial.step({
      name: "mobile_guidance_policy", prompt: "Analyze the capture before applying turn-only prerequisites.",
      response: guidancePolicy.version, model: "mobile-field-policy", success: true,
    });
    const initialSensorReasons = guidancePolicy.initialSensorReasons(sensors, { lat, lng }, deviceHeading, gpsAccuracyMeters, safetyNow());
    if (initialSensorReasons.length) return trial.withhold(initialSensorReasons);

    logRequest(request, image);
    const input = await classifyInput(trial, request, image);
    if (input.kind === "exit") return input.result;
    const destinationQuery = input.value;

    try {
      const destinationResult = await verifyDestination(trial, request, destinationQuery);
      if (destinationResult.kind === "exit") return destinationResult.result;
      const place = destinationResult.value;

      const panoramaSearch = startPanoramaSearch(trial, { lat, lng }, pinnedPanorama);
      const { entrance, closedNotice } = await findEntrance(trial, request, place);

      const proximity = await passProximityGate(trial, {
        request, destinationQuery, place, entrance, closedNotice,
        firstPanorama: panoramaSearch.first, analysisGate: guidancePolicy.analysisGate,
      });
      if (proximity.kind === "exit") return proximity.result;
      const { destinationBearing } = proximity.value.headingAlignment;

      const matching = await matchPanoramaHeadings(trial, {
        request, image, destinationQuery, place, entrance, closedNotice, search: panoramaSearch,
      });
      if (matching.kind === "exit") return matching.result;
      const headings = matching.value;

      const turn = await decideTurn(trial, {
        request, entrance, headings, guidanceHeading, turnReasons: guidancePolicy.turnReasons, sensorReasons: turnSensorReasons,
      });
      if (turn.kind === "withhold") return await trial.withhold(turn.reasons, TURN_NOT_VERIFIED_MESSAGE);
      const { turnHeading, confidence, walkingEvidence } = turn;

      const { turnInstruction, finalOutput } = await composeGuidance(trial, {
        request, image, place, entrance, destinationBearing, turnHeading, walkingEvidence,
        reference: headings.reference, panoramaDate: headings.panorama.metadata.date, closedNotice, policy: guidancePolicy,
      });

      const lateReasons = turnSensorReasons();
      if (lateReasons.length) return await trial.withhold(lateReasons);
      return await trial.answer({
        currentHeading: turnHeading,
        targetHeading: destinationBearing,
        confidenceLevel: confidence.level,
        confidenceScore: confidence.score,
      }, {
        finalOutput,
        success: true,
        targetHeading: destinationBearing,
        turnInstruction,
      });
    } catch (error) {
      return trial.fail(error);
    }
  }
}

function logRequest(request: LastMetersRequestInput, image: string): void {
  console.log("\n==================================================");
  console.log("📥 [BACKEND] HIT RECEIVED ON THE LAST METERS ROUTE!");
  console.log(`[BACKEND] Destination requested: "${request.destination}"`);
  console.log(`[BACKEND] Coordinates: lat=${request.lat}, lng=${request.lng}`);
  console.log(
    `[BACKEND] Image payload received (Base64 length): ${image?.length}`,
  );
  console.log("==================================================");
}

export interface LastMetersRunOptions {
  /**
   * Use this user-position panorama instead of searching for one. The caller
   * has already checked it with fetchStreetViewPanoramaById, so the pipeline
   * does not look it up again.
   */
  pinnedPanorama?: StreetViewMetadata;
  /** Set for dashboard retries: link the log to the original, reuse its photo. */
  retry?: {
    retryOf: string;
    panoramaMode: RetryPanoramaMode;
    defaultsApplied: string[];
    /** The original's snapshot, upgraded to the current version. */
    replayInput: ReplayInput;
  };
  /** Set for app requests: the path the request arrived on. */
  requestPath?: LastMetersPath;
}

export type LastMetersRunResult =
  | {
      kind: "response";
      status: number;
      body: Record<string, unknown>;
      testLogId?: string;
      /** Settles once a review-only panorama is attached to the log. */
      reviewPanorama?: Promise<void>;
    }
  | {
      /** The input was a question; the caller answers it with textRequest. */
      kind: "question";
      testLogId?: string;
      textRequest: textRequestBody;
    };
