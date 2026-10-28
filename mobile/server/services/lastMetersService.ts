import { textRequestBody, AppContext } from "../types";
import dotenv from "dotenv";
import { getOpenAIClient } from "./openAIClient";
import { strictLastMetersGuidancePolicy, type LastMetersGuidancePolicy } from "../utils/lastMetersGuidancePolicy";
import type { LastMetersRequestInput, ReplayInput } from "../utils/lastMetersReplay";
import type { RetryPanoramaMode } from "../database/models/lastMetersTestLog";
import type { LastMetersPath } from "../config/lastMetersPaths";
import { SceneClassifier, PanoramaAudit, PanoramaAttempt, PanoramaSearchBudget } from "./outdoorPanoramaSelection";
import { buildLastMetersSourceNote, LAST_METERS_EXACT_RADIUS_METERS } from "../utils/lastMetersNavigation";
import { parseLastMetersInput } from "../../src/utils/lastMetersInput";
import {
  classifyPanoramaScene,
  processPanoramaTiles,
  saveBackgroundPanorama,
  type StreetViewMetadata,
} from "./streetViewPanorama";
import { OpenAIQuestionService } from "./openAIQuestionService";
import { LastMetersTrial } from "./lastMetersTrial";
import { findEntrance, proximityGatePrompt, verifyDestination } from "./lastMetersDestination";
import { resolveProximityGate } from "./lastMetersProximityGate";
import { matchPanoramaHeadings, type PanoramaSearch } from "./lastMetersPanoramaMatching";
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
    const {
      lat,
      lng,
      destination,
      deviceHeading,
      gpsAccuracyMeters,
      sensors,
    } = request;
    const { retry, pinnedPanorama } = options;
    const trial = new LastMetersTrial({ request, image, options, policy: guidancePolicy });
    // A retry keeps the original's snapshot and judges sensor freshness as of
    // the original request.
    const evaluationTime = retry?.replayInput.receivedAt ?? trial.startedAt;
    const guidanceHeading = guidancePolicy.guidanceHeading(request, evaluationTime);
    const safetyNow = () => evaluationTime + Date.now() - trial.startedAt;
    const turnSensorReasons = () =>
      guidancePolicy.turnSensorReasons(sensors, { lat, lng }, deviceHeading, gpsAccuracyMeters, safetyNow(), evaluationTime);
    const panoramaValidation: PanoramaAttempt[] = [];
    trial.note({ panoramaValidation });
    const auditPanorama: PanoramaAudit = attempt => panoramaValidation.push(attempt);
    const classifyPanorama: SceneClassifier = (images, timeoutMs) => classifyPanoramaScene(getOpenAIClient(), images, timeoutMs);

    // Identify field policy changes separately from the shared pipeline and replay schema versions.
    if (guidancePolicy.version) trial.step({
      name: "mobile_guidance_policy", prompt: "Analyze the capture before applying turn-only prerequisites.",
      response: guidancePolicy.version, model: "mobile-field-policy", success: true,
    });
    const initialSensorReasons = guidancePolicy.initialSensorReasons(sensors, { lat, lng }, deviceHeading, gpsAccuracyMeters, safetyNow());
    if (initialSensorReasons.length) return trial.withhold(initialSensorReasons);

    console.log("\n==================================================");
    console.log("📥 [BACKEND] HIT RECEIVED ON THE LAST METERS ROUTE!");
    console.log(`[BACKEND] Destination requested: "${destination}"`);
    console.log(`[BACKEND] Coordinates: lat=${lat}, lng=${lng}`);
    console.log(
      `[BACKEND] Image payload received (Base64 length): ${image?.length}`,
    );
    console.log("==================================================");

    const parsedInput = parseLastMetersInput(destination);
    if (parsedInput.kind === "question") {
      // Older app builds send questions here; answer them like the main
      // question box would instead of searching for a place named "When is...".
      trial.note({ testScenario: "question_routed" });
      trial.step({
        name: "input_classification",
        prompt:
          "Decide whether the Last Meters input names a place or asks a question.",
        response: `QUESTION (${parsedInput.reason}): sent to the question answering flow`,
        model: "deterministic-parser",
        success: true,
      });
      const asksAboutSurroundings =
        parsedInput.reason === "question" &&
        /\b(?:in front of me|around me|describe|what do you see|this)\b/i.test(
          destination,
        );
      return trial.question({
        text: destination,
        image: asksAboutSurroundings && image ? [image] : undefined,
        coords: {
          latitude: lat,
          longitude: lng,
          accuracy: gpsAccuracyMeters ?? null,
          heading: deviceHeading ?? null,
        },
        analytics: {
          feature:
            parsedInput.reason === "transit"
              ? "mta"
              : asksAboutSurroundings
                ? "photo_qa"
                : undefined,
        },
      });
    }
    const destinationQuery = parsedInput.destination;
    trial.note({ destinationQuery });
    trial.step({
      name: "input_classification",
      prompt:
        "Decide whether the Last Meters input names a place or asks a question.",
      response:
        `DESTINATION: "${destinationQuery}"` +
        (parsedInput.strippedLeadIn ? " (question lead-in removed)" : ""),
      model: "deterministic-parser",
      success: true,
    });

    try {
      const proximityPrompt = proximityGatePrompt(destinationQuery);
      const destinationResult = await verifyDestination(trial, request, destinationQuery);
      if (destinationResult.kind === "exit") return destinationResult.result;
      const verifiedDestination = destinationResult.value;

      // The panorama is taken at the user's position, so it can download
      // while the entrance lookup runs. Approach and aligned trials save it
      // for review after they have already answered.
      const panoramaBudget: PanoramaSearchBudget = { seen: new Set(), deadline: Date.now() + 45_000 };
      const panoramaSearch: PanoramaSearch = {
        first: processPanoramaTiles(lat, lng, classifyPanorama, auditPanorama, panoramaBudget, pinnedPanorama),
        budget: panoramaBudget,
        classify: classifyPanorama,
        audit: auditPanorama,
        pinned: pinnedPanorama !== undefined,
      };
      void panoramaSearch.first.catch(() => undefined);

      const { entrance, closedNotice } = await findEntrance(trial, request, verifiedDestination);
      const distanceMeters = entrance.distanceMeters;
      const place = verifiedDestination;

      const { mode, headingAlignment, gate } = resolveProximityGate(request, entrance, guidancePolicy.analysisGate);
      const { destinationBearing, differenceDegrees, aligned } = headingAlignment;
      if (typeof deviceHeading === "number" && differenceDegrees !== undefined) {
        trial.step({
          name: "heading_alignment",
          prompt:
            "Compare the phone compass heading with the verified destination bearing.",
          response:
            `${aligned ? "ALIGNED" : "MISALIGNED"}: phone ` +
            `${deviceHeading.toFixed(1)} degrees, destination ` +
            `${destinationBearing.toFixed(1)} degrees, difference ` +
            `${differenceDegrees.toFixed(1)} degrees`,
          model: "deterministic-compass",
          success: true,
        });
      }

      trial.note({ headingAlignment });

      trial.source("phone_gps");
      if (typeof deviceHeading === "number") trial.source("phone_compass");

      trial.note({ gate });

      if (mode === "aligned") {
        trial.note({ navigationMode: "aligned", testScenario: "heading_aligned" });
        trial.step({
          name: "proximity_gate",
          prompt: proximityPrompt,
          response: `APPROACH_ONLY: ${Math.round(distanceMeters)} meters`,
          model: "google-places",
          success: true,
        });
        const finalOutput =
          `${place.placeName}, ${place.placeAddress}, is approximately ${Math.round(distanceMeters)} meters away in a straight line. A walking route has not been verified. Use your primary walking navigation before trying Last Meters closer to the destination.` +
          closedNotice +
          buildLastMetersSourceNote(null);
        return await trial.answer({ warning: "heading_already_aligned" }, { finalOutput, success: true },
          testLogId => saveBackgroundPanorama(testLogId, panoramaSearch.first));
      }

      if (mode === "approach") {
        trial.note({ navigationMode: "approach", testScenario: "test_b_approach" });
        const finalOutput =
          `${place.placeName}, ${place.placeAddress}, is approximately ${Math.round(distanceMeters)} meters away in a straight line. A walking route has not been verified. Use your primary walking navigation before trying Last Meters closer to the destination.` +
          closedNotice +
          buildLastMetersSourceNote(null);
        trial.step({
          name: "proximity_gate",
          prompt: proximityPrompt,
          response:
            `APPROACH_ONLY: ${Math.round(distanceMeters)} meters, ` +
            `${destinationBearing.toFixed(1)} degrees`,
          model: "google-places",
          success: true,
        });
        return await trial.answer({ warning: "destination_too_far" }, { finalOutput, success: true },
          testLogId => saveBackgroundPanorama(testLogId, panoramaSearch.first));
      }

      // mode === "exact"
      trial.note({ navigationMode: "exact" });
      trial.step({
        name: "proximity_gate",
        prompt: proximityPrompt,
        response:
          `EXACT: ${Math.round(distanceMeters)} meters` +
          (gate.widened
            ? ` (within ${LAST_METERS_EXACT_RADIUS_METERS} m after a ` +
              `${Math.round(gate.allowanceMeters)} m GPS allowance)`
            : ""),
        model: "google-places",
        success: true,
      });

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
