import axios from "axios";
import { textRequestBody, AppContext } from "../types";
import dotenv from "dotenv";
import { getOpenAIClient } from "./openAIClient";
import { strictLastMetersGuidancePolicy, type LastMetersGuidancePolicy } from "../utils/lastMetersGuidancePolicy";
import { evaluateWalkingLeg, WalkingEvidence } from "../utils/lastMetersPolicy";
import type { LastMetersRequestInput, ReplayInput } from "../utils/lastMetersReplay";
import type { RetryPanoramaMode } from "../database/models/lastMetersTestLog";
import type { LastMetersPath } from "../config/lastMetersPaths";
import { SceneClassifier, PanoramaAudit, PanoramaAttempt, PanoramaSearchBudget } from "./outdoorPanoramaSelection";
import {
  buildLastMetersDistanceSentence,
  buildLastMetersSourceNote,
  buildLastMetersTurnInstruction,
  calculateLastMetersConfidence,
  LAST_METERS_EXACT_RADIUS_METERS,
  streetViewImageryAgeYears,
} from "../utils/lastMetersNavigation";
import { parseLastMetersInput } from "../../src/utils/lastMetersInput";
import { getGoogleMapsApiKey } from "./googleMaps";
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
      compassAccuracyLevel,
      sensors,
    } = request;
    const { retry, pinnedPanorama } = options;
    const trial = new LastMetersTrial({ request, image, options, policy: guidancePolicy });
    // A retry keeps the original's snapshot and judges sensor freshness as of
    // the original request.
    const evaluationTime = retry?.replayInput.receivedAt ?? trial.startedAt;
    const guidanceHeading = guidancePolicy.guidanceHeading(request, evaluationTime);
    const safetyNow = () => evaluationTime + Date.now() - trial.startedAt;
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
      const targetLocation = entrance.location;
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
      const { currentHeading, comparison, visualMatch, signTextMatched, reference, panorama } = matching.value;
      const destinationReferenceUsed = reference !== undefined;
      const panoramaDate = panorama.metadata.date;
      const panoramaAgeYears = streetViewImageryAgeYears(panoramaDate);
      const panoramaMatched = comparison.panoramaMatchedHeading !== null;
      const confidence = calculateLastMetersConfidence({
        gpsAccuracyMeters,
        compassAccuracyLevel,
        panoramaCurrentViewMatched: panoramaMatched,
        compassPanoramaAgrees: comparison.agrees,
        destinationVisuallyMatched: visualMatch || signTextMatched,
        destinationReferenceVerified: destinationReferenceUsed,
        panoramaAgeYears,
      });
      trial.note({ confidence });
      trial.step({
        name: "confidence_fusion", prompt: "Score independent evidence before the turn safety gate; this is a heuristic, not a calibrated probability.",
        response: `${confidence.level.toUpperCase()}: ${Math.round(confidence.score * 100)}%`,
        model: "deterministic-confidence", success: confidence.level === "high",
        error: confidence.level !== "high" ? confidence.reasons.join(" ") : undefined,
      });
      let walkingEvidence: WalkingEvidence;
      try {
        const route = await axios.get("https://maps.googleapis.com/maps/api/directions/json", {
          params: { mode: "walking", origin: `${lat},${lng}`, destination: `${targetLocation.lat},${targetLocation.lng}`, key: getGoogleMapsApiKey() }, timeout: 8000,
        });
        walkingEvidence = route.data.status === "OK"
          ? evaluateWalkingLeg(route.data.routes?.[0]?.legs?.[0], { lat, lng }, targetLocation)
          : { verified: false, reason: "walking_route_unavailable" };
      } catch { walkingEvidence = { verified: false, reason: "walking_route_unavailable" }; }
      trial.note({ walkingEvidence });
      const turnReasons = guidancePolicy.turnReasons({ confidenceLevel: confidence.level,
        photoMatched: panoramaMatched, headingAgrees: comparison.agrees,
        compassAccuracy: compassAccuracyLevel, gpsAccuracy: gpsAccuracyMeters, distanceMeters,
        entranceListed: entrance.source === "geocoding_entrance",
        visualTargetMatched: visualMatch || signTextMatched || destinationReferenceUsed,
        walking: walkingEvidence, sensorReasons: guidancePolicy.turnSensorReasons(sensors, { lat, lng }, deviceHeading, gpsAccuracyMeters, safetyNow(), evaluationTime) });
      if (turnReasons.length) return await trial.withhold(turnReasons, "I cannot verify the entrance and your orientation well enough for a precise turn. Stay in a safe place and use your primary walking navigation or ask for assistance. Entrance accessibility has not been verified.");
      // Visual bearings remain camera-origin evidence. Guidance uses phone-origin geometry.
      const turnHeading = guidanceHeading ?? currentHeading;
      trial.note({ currentHeading: turnHeading });

      // ==========================================
      // TYPESCRIPT MATH CALCULATION (Bulletproof Turn Logic)
      // ==========================================
      const turnInstruction = buildLastMetersTurnInstruction(turnHeading, destinationBearing);
      const distanceSentence = buildLastMetersDistanceSentence(
        place.placeName,
        distanceMeters,
        !turnInstruction.startsWith("No turn"),
      );

      // ==========================================
      // STEP 3: ACCESSIBLE GUIDANCE & LANDMARKS
      // ==========================================
      trial.stage("accessible guidance");
      console.log("   ➤ Step 3: Generating Accessible Guidance...");
      const destinationReferenceContext = destinationReferenceUsed
        ? `A separate Street View image for "${place.placeName}" is also provided. It was captured ${reference?.date || "on an unknown date"} and may be outdated. Use it only as historical entrance context, never as proof of current conditions.`
        : "No separate destination reference image is provided.";
      const step3Prompt = `You are an orientation assistant for a blind pedestrian.
The validated turn instruction is: "${turnInstruction}"
${destinationReferenceContext}
Describe at most two stable physical landmarks. Use the user's current photo for a landmark useful while turning in place. If a destination reference is provided, you may also describe one clearly visible entrance feature and must prefix it with "Street View reference:".
Only mention stable, cane-detectable or tactile features such as a wall edge, curb, doorway recess, railing, or steps.
Do not name, describe, or direct the user toward any business other than "${place.placeName || destination}". If the requested destination's entrance is not verified, omit entrance guidance rather than substituting a neighboring storefront.
Never claim that a reference-image feature is currently present or visible from the user's position. Never invent an object. Never say "look", "see", "watch", "keep an eye out", or promise that a path is clear.
Do not instruct the user to walk forward or cross a street. If no reliable landmark is visible, reply exactly: NO_RELIABLE_LANDMARKS.
Keep the response to two short sentences and do not repeat the turn instruction.` + (guidancePolicy.landmarkContext ?? "");
      const step3UserContent: any[] = [
        { type: "text", text: "--- USER'S CURRENT PHOTO ---" },
        { type: "image_url", image_url: { url: image, detail: "high" } },
      ];
      if (reference) {
        step3UserContent.push(
          {
            type: "text",
            text: "--- DESTINATION-FOCUSED STREET VIEW REFERENCE ---",
          },
          {
            type: "image_url",
            image_url: { url: reference.photo, detail: "high" },
          },
        );
      }
      const step3Response = await getOpenAIClient().chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: step3Prompt },
          { role: "user", content: step3UserContent },
        ],
        temperature: 0.1,
        max_tokens: 100,
      });

      const step3Text = step3Response.choices[0].message.content?.trim() || "";
      const landmarksGuidance =
        !step3Text || /\bNO_RELIABLE_LANDMARKS\b/i.test(step3Text)
          ? "No reliable physical landmark was identified. Turn in place without moving forward, then confirm your orientation before continuing."
          : step3Text;
      trial.step({
        name: "accessible_guidance",
        prompt: step3Prompt,
        response: step3Text,
        model: "gpt-4o-mini",
        success: !!step3Text && !/\bNO_RELIABLE_LANDMARKS\b/i.test(step3Text),
        error:
          !step3Text || /\bNO_RELIABLE_LANDMARKS\b/i.test(step3Text)
            ? "No reliable physical landmark was identified."
            : undefined,
        tokenCount: step3Response.usage?.total_tokens,
      });

      // --- FINAL OUTPUT FOR TERMINAL ---
      console.log("\n💬 AI 3-Step Navigation Output:");
      console.log(
        `- 1st Match (Current View): The user is facing ${turnHeading}°.`,
      );
      console.log(
        `- 2nd Match (Target Store): The target '${destination}' is located at ${destinationBearing}°.`,
      );
      console.log(
        `- 3rd Step (Guidance): ${turnInstruction} Landmarks: ${landmarksGuidance}`,
      );
      console.log("=========================================\n");

      const lateReasons = guidancePolicy.turnSensorReasons(sensors, { lat, lng }, deviceHeading, gpsAccuracyMeters, safetyNow(), evaluationTime);
      if (lateReasons.length) return await trial.withhold(lateReasons);
      const finalOutput = guidancePolicy.finalOutput({
        turnInstruction, distanceSentence, landmarksGuidance, closedNotice, panoramaDate, walkingEvidence,
      });
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
