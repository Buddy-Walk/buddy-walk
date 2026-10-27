import axios from "axios";
import { textRequestBody, AppContext } from "../types";
import dotenv from "dotenv";
import { getOpenAIClient } from "./openAIClient";
import { lastMileTestLogService } from "./lastMileTestLog";
import sharp from "sharp";
import { RECAPTURE_MESSAGE } from "../../src/utils/lastMileSafety";
import { strictLastMileGuidancePolicy, type LastMileGuidancePolicy } from "../utils/lastMileGuidancePolicy";
import { evaluateWalkingLeg, WalkingEvidence } from "../utils/lastMilePolicy";
import {
  LAST_MILE_PIPELINE_VERSION,
  STORED_PHOTO_JPEG_QUALITY,
  STORED_PHOTO_MAX_WIDTH,
  buildReplayInput,
  type LastMetersRequestInput,
  type ReplayInput,
} from "../utils/lastMileReplay";
import type { RetryPanoramaMode } from "../database/models/lastMileTestLog";
import { outdoorPanoramaRejection } from "../utils/outdoorPanorama";
import { selectOutdoorPanorama, SceneClassifier, PanoramaAudit, PanoramaAttempt, PanoramaSearchBudget } from "./outdoorPanoramaSelection";
import {
  buildClosedNowNotice,
  buildHeadingConflictInstruction,
  buildLastMileDistanceSentence,
  buildLastMileSourceNote,
  buildLastMileTurnInstruction,
  calculateLastMileConfidence,
  compareCompassAndPanoramaHeadings,
  formatLastMileDistance,
  isLastMileHeadingAligned,
  lastMileHeadingDifference,
  LAST_MILE_HEADINGS,
  LAST_MILE_PANORAMA_FOV_DEGREES,
  LAST_METERS_EXACT_RADIUS_METERS,
  parseDestinationVisibility,
  parseLastMileHeading,
  resolveVerifiedTargetHeading,
  shouldUseDestinationReference,
  snapLastMileHeading,
  streetViewImageryAgeYears,
} from "../utils/lastMileNavigation";
import type { LastMileTestScenario } from "../utils/lastMileNavigation";
import {
  normalizeNearbyPlaceQuery,
  signTextMatchesPlaceName,
} from "../utils/nearbyPlaces";
import type { PlaceCandidateLog } from "../utils/nearbyPlaces";
import {
  isBesideBuilding,
  parseBuildingGeometry,
  selectNearestEntrance,
  usesBuildingEntrances,
} from "../utils/buildingEntrances";
import type { BuildingGeometry } from "../utils/buildingEntrances";
import { parseLastMetersInput } from "../../src/utils/lastMetersInput";
import { calculateHeading, getGoogleMapsApiKey, type LatLng } from "./googleMaps";
import {
  DestinationNotVerifiedError,
  getVerifiedNearbyDestination,
  type VerifiedNearbyDestination,
} from "./verifiedDestination";
import {
  buildPanoramaDebugImage,
  classifyPanoramaScene,
  fetchSignCloseUps,
  processPanoramaTiles,
  saveBackgroundPanorama,
  type StreetViewMetadata,
} from "./streetViewPanorama";
import { OpenAIQuestionService } from "./openAIQuestionService";
dotenv.config();

interface DestinationStreetViewReference {
  photo: string;
  date?: string;
  status: string;
  placeName: string;
  placeAddress: string;
  targetHeading: number;
}

/**
 * Building outline and entrance points from Geocoding. Optional data: any
 * failure means the trial falls back to the single Places pin.
 */
async function getBuildingGeometry(
  placeId: string,
): Promise<BuildingGeometry | null> {
  try {
    const response = await axios.get(
      "https://maps.googleapis.com/maps/api/geocode/json",
      {
        params: {
          place_id: placeId,
          extra_computations: "BUILDING_AND_ENTRANCES",
          key: getGoogleMapsApiKey(),
        },
        timeout: 8_000,
      },
    );
    if (response.data.status !== "OK" || !response.data.results?.[0]) {
      return null;
    }
    return parseBuildingGeometry(response.data.results[0]);
  } catch (error) {
    console.warn("[Last Meters] Building entrance lookup failed:", error);
    return null;
  }
}

async function getDestinationStreetViewReference(
  lat: number,
  lng: number,
  destination: string,
  resolvedDestination: VerifiedNearbyDestination | undefined,
  classify: SceneClassifier,
  audit: PanoramaAudit,
): Promise<DestinationStreetViewReference> {
  const nearbyQuery = normalizeNearbyPlaceQuery(destination);
  if (!nearbyQuery) {
    throw new Error("Destination name was empty after normalization.");
  }
  const nearbyPlace =
    resolvedDestination ??
    (await getVerifiedNearbyDestination(lat, lng, nearbyQuery, 2_000));
  const placeLocation = nearbyPlace.location;
  if (nearbyPlace.distanceMeters < 3) {
    throw new Error(
      "Destination coordinates are too close to determine an entrance direction.",
    );
  }

  const { metadata } = await selectOutdoorPanorama(
    placeLocation.lat, placeLocation.lng, getGoogleMapsApiKey(), classify, audit,
  );
  const rejection = outdoorPanoramaRejection(metadata);
  if (rejection || !metadata.location) {
    throw new Error(
      `Destination outdoor Street View rejected: ${rejection}.`,
    );
  }

  const cameraHeading = calculateHeading(metadata.location, {
    lat: placeLocation.lat,
    lng: placeLocation.lng,
  });
  const imageResponse = await axios.get(
    "https://maps.googleapis.com/maps/api/streetview",
    {
      params: {
        size: "640x640",
        pano: metadata.pano_id,
        heading: cameraHeading.toFixed(1),
        fov: 80,
        pitch: 0,
        source: "outdoor",
        return_error_code: true,
        key: getGoogleMapsApiKey(),
      },
      responseType: "arraybuffer",
      timeout: 20_000,
    },
  );

  return {
    photo: `data:image/jpeg;base64,${Buffer.from(imageResponse.data).toString("base64")}`,
    date: metadata.date,
    status: metadata.status,
    placeName: nearbyPlace.placeName,
    placeAddress: nearbyPlace.placeAddress,
    targetHeading: snapLastMileHeading(
      calculateHeading(
        { lat, lng },
        { lat: placeLocation.lat, lng: placeLocation.lng },
      ),
    ),
  };
}

export class LastMetersService {
  /** Answers Last Meters inputs that turn out to be Questions. */
  constructor(private readonly questionService: OpenAIQuestionService = new OpenAIQuestionService()) {}

  /** Use the existing policy by default; a mobile subclass can choose its own field-only policy. */
  protected lastMileGuidancePolicy(_options: LastMetersRunOptions): LastMileGuidancePolicy {
    return strictLastMileGuidancePolicy;
  }

  // --- LAST METERS NAVIGATION PIPELINE ---
  /** Runs Last Meters for an app request and sends the answer. */
  async lastMileRequest(
    ctx: AppContext,
    request: LastMetersRequestInput,
    image: string,
  ) {
    const result = await this.runLastMeters(request, image);
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
    const guidancePolicy = this.lastMileGuidancePolicy(options);
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
    const startedAt = Date.now();
    // A retry keeps the original's snapshot and judges sensor freshness as of
    // the original request.
    const evaluationTime = retry?.replayInput.receivedAt ?? startedAt;
    const guidanceHeading = guidancePolicy.guidanceHeading(request, evaluationTime);
    const safetyNow = () => evaluationTime + Date.now() - startedAt;
    let safetyReasons: string[] = [];
    let walkingEvidence: WalkingEvidence = { verified: false, reason: "walking_route_not_checked" };
    let panoramaTargetHeading: number | undefined;
    const replayInput = retry?.replayInput ?? buildReplayInput(request, image, startedAt);
    let recordedLogId: string | undefined;
    let activeStage = "destination proximity check";
    let navigationMode: "approach" | "exact" | "aligned" | undefined;
    let testScenario: LastMileTestScenario | undefined;
    let destinationDistanceMeters: number | undefined;
    let destinationBearing: number | undefined;
    let headingDifferenceDegrees: number | undefined;
    let headingAligned: boolean | undefined;
    let compassHeading: number | undefined;
    let panoramaMatchedHeading: number | undefined;
    let headingComparisonDifference: number | undefined;
    let headingComparisonAgrees: boolean | undefined;
    let confidenceScore: number | undefined;
    let confidenceLevel: "high" | "medium" | "low" | undefined;
    let confidenceReasons: string[] | undefined;
    let currentHeading: number | undefined;
    let verifiedDestination: VerifiedNearbyDestination | undefined;
    let panoramaPhoto: string | undefined;
    let panoramaDate: string | undefined;
    let panoramaStatus: string | undefined;
    const panoramaValidation: PanoramaAttempt[] = [];
    const auditPanorama: PanoramaAudit = attempt => panoramaValidation.push(attempt);
    const classifyPanorama: SceneClassifier = (images, timeoutMs) => classifyPanoramaScene(getOpenAIClient(), images, timeoutMs);
    let panoramaHeadings: number[] = [];
    let destinationPhoto: string | undefined;
    let destinationPhotoDate: string | undefined;
    let destinationPhotoStatus: string | undefined;
    let destinationPlaceName: string | undefined;
    let destinationPlaceAddress: string | undefined;
    let destinationTypes: string[] = [];
    let destinationReferenceUsed = false;
    let destinationQuery = destination;
    let placeCandidates: PlaceCandidateLog[] | undefined;
    let placesSearches: string[] | undefined;
    let gpsAllowanceMeters: number | undefined;
    let exactGateWidened: boolean | undefined;
    let panoId: string | undefined;
    let panoramaCopyright: string | undefined;
    let panoramaAgeYears: number | undefined;
    let entranceSource: "places_pin" | "geocoding_entrance" | undefined;
    let entranceLocation: LatLng | undefined;
    let besideBuilding: boolean | undefined;
    let signText: string | undefined;
    let signTextMatched: boolean | undefined;
    const dataSources = new Set<string>();
    const testSteps: {
      name: string;
      prompt: string;
      response?: string;
      parsedHeading?: number;
      model: string;
      success: boolean;
      error?: string;
      tokenCount?: number;
      durationMs?: number;
      panoId?: string;
    }[] = [];

    // Identify field policy changes separately from the shared pipeline and replay schema versions.
    if (guidancePolicy.version) testSteps.push({
      name: "mobile_guidance_policy", prompt: "Analyze the capture before applying turn-only prerequisites.",
      response: guidancePolicy.version, model: "mobile-field-policy", success: true,
    });
    const trialContext = () => ({
      replayInput,
      safetyReasons,
      walkingEvidence,
      panoramaTargetHeading,
      confidenceMethod: "heuristic-not-calibrated" as const,
      destination,
      destinationQuery,
      lat,
      lng,
      panoramaPhoto,
      panoramaDate,
      panoramaStatus,
      panoramaValidation,
      panoramaSource: panoramaPhoto ? ("pipeline" as const) : undefined,
      panoId,
      panoramaCopyright,
      panoramaAgeYears,
      panoramaHeadings,
      placeCandidates,
      placesSearches,
      gpsAllowanceMeters,
      exactGateWidened,
      entranceSource,
      entranceLat: entranceLocation?.lat,
      entranceLng: entranceLocation?.lng,
      besideBuilding,
      destinationOpenNow: verifiedDestination?.openNow,
      destinationBusinessStatus: verifiedDestination?.businessStatus,
      signText,
      signTextMatched,
      dataSources: [...dataSources],
      destinationPhoto,
      destinationPhotoDate,
      destinationPhotoStatus,
      destinationPlaceName,
      destinationPlaceAddress,
      destinationTypes,
      destinationDistanceMeters,
      gpsAccuracyMeters,
      compassAccuracyLevel,
      destinationBearing,
      deviceHeading,
      headingDifferenceDegrees,
      headingAligned,
      compassHeading,
      panoramaMatchedHeading,
      headingComparisonDifference,
      headingComparisonAgrees,
      confidenceScore,
      confidenceLevel,
      confidenceReasons,
      destinationReferenceUsed,
      navigationMode,
      testScenario,
      currentHeading,
      steps: testSteps,
      latencyMs: Date.now() - startedAt,
    });
    const recordTrial = async (outcome: {
      finalOutput?: string;
      success: boolean;
      error?: string;
      targetHeading?: number;
      turnInstruction?: string;
    }) => {
      recordedLogId = await lastMileTestLogService.record({
        ...trialContext(),
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
              userPhoto: await resizeDataUrlImage(
                image,
                STORED_PHOTO_MAX_WIDTH,
                STORED_PHOTO_JPEG_QUALITY,
              ),
            }),
        ...outcome,
      });
      return recordedLogId;
    };
    const respond = (
      status: number,
      body: Record<string, unknown>,
      reviewPanorama?: Promise<void>,
    ): LastMetersRunResult => ({
      kind: "response",
      status,
      body,
      testLogId: recordedLogId,
      reviewPanorama,
    });

    const withhold = async (reasons: string[], message = RECAPTURE_MESSAGE) => {
      safetyReasons = [...new Set(reasons)];
      message = guidancePolicy.withheldMessage(safetyReasons, message, trialContext());
      testSteps.push({ name: "turn_safety_gate", prompt: "Require sufficient evidence before any precise turn.",
        response: safetyReasons.join("; "), model: "deterministic-safety-policy", success: false });
      const testLogId = await recordTrial({ finalOutput: message, success: false, error: "turn_withheld" });
      return respond(200, { output: message, testLogId, warning: "turn_withheld", safetyReasons,
        guidanceKind: "withheld", targetHeading: null, pipelineVersion: LAST_MILE_PIPELINE_VERSION });
    };
    const initialSensorReasons = guidancePolicy.initialSensorReasons(sensors, { lat, lng }, deviceHeading, gpsAccuracyMeters, safetyNow());
    if (initialSensorReasons.length) return withhold(initialSensorReasons);

    console.log("\n==================================================");
    console.log("📥 [BACKEND] HIT RECEIVED ON /api/last-mile route!");
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
      testScenario = "question_routed";
      testSteps.push({
        name: "input_classification",
        prompt:
          "Decide whether the Last Meters input names a place or asks a question.",
        response: `QUESTION (${parsedInput.reason}): sent to the question answering flow`,
        model: "deterministic-parser",
        success: true,
      });
      await recordTrial({
        finalOutput: "Answered by the question answering flow.",
        success: true,
      });
      const asksAboutSurroundings =
        parsedInput.reason === "question" &&
        /\b(?:in front of me|around me|describe|what do you see|this)\b/i.test(
          destination,
        );
      return {
        kind: "question",
        testLogId: recordedLogId,
        textRequest: {
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
        },
      };
    }
    destinationQuery = parsedInput.destination;
    testSteps.push({
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
      const proximityPrompt =
        `Resolve "${destinationQuery}" near the user's coordinates and use exact ` +
        `panorama matching only within ${LAST_METERS_EXACT_RADIUS_METERS} meters ` +
        "plus the phone's reported GPS error.";
      try {
        verifiedDestination = await getVerifiedNearbyDestination(
          lat,
          lng,
          destinationQuery,
        );
        dataSources.add("google_places");
        destinationDistanceMeters = verifiedDestination.distanceMeters;
        destinationPlaceName = verifiedDestination.placeName;
        destinationPlaceAddress = verifiedDestination.placeAddress;
        destinationTypes = verifiedDestination.types;
        placeCandidates = verifiedDestination.placeCandidates;
        placesSearches = verifiedDestination.placesSearches;
        testSteps.push({
          name: "destination_candidates",
          prompt:
            "Rank relevant Google Places candidates by distance from the user.",
          response: verifiedDestination.candidateSummary,
          model: "google-places",
          success: true,
        });
      } catch (proximityError) {
        testScenario = "destination_unverified";
        if (proximityError instanceof DestinationNotVerifiedError) {
          placeCandidates = proximityError.placeCandidates;
          placesSearches = proximityError.placesSearches;
          dataSources.add("google_places");
        }
        const message =
          proximityError instanceof Error
            ? proximityError.message
            : "Destination proximity lookup failed.";
        testSteps.push({
          name: "proximity_gate",
          prompt: proximityPrompt,
          response: "DESTINATION_NOT_VERIFIED",
          model: "google-places",
          success: false,
          error: message,
        });
        const finalOutput =
          `I could not verify a nearby ${destinationQuery} from your current location. ` +
          "Try a more specific name or street address." +
          buildLastMileSourceNote(null);
        const testLogId = await recordTrial({
          finalOutput,
          success: false,
          error: "destination_not_verified",
        });
        return respond(200, {
          output: finalOutput,
          testLogId,
          testScenario,
          warning: "destination_not_verified",
        });
      }

      const ambiguity = (verifiedDestination.placeCandidates || []).filter(candidate => candidate.relevant &&
        candidate.placeId !== verifiedDestination!.placeId && candidate.businessStatus !== "CLOSED_PERMANENTLY" &&
        candidate.distanceMeters <= verifiedDestination!.distanceMeters + Math.max(20, gpsAccuracyMeters ?? 20));
      if (ambiguity.length) {
        return withhold(["destination_branch_ambiguous"], `I found more than one nearby ${destinationQuery}. Please specify the street address: ${verifiedDestination.placeAddress} or ${ambiguity.slice(0, 2).map(c => c.address).join(" or ")}.`);
      }

      // The panorama is taken at the user's position, so it can download
      // while the entrance lookup runs. Approach and aligned trials save it
      // for review after they have already answered.
      const panoramaBudget: PanoramaSearchBudget = { seen: new Set(), deadline: Date.now() + 45_000 };
      const panoramaDownload = processPanoramaTiles(lat, lng, classifyPanorama, auditPanorama, panoramaBudget, pinnedPanorama);
      panoramaDownload.catch(() => undefined);

      let targetLocation: LatLng = verifiedDestination.location;
      entranceSource = "places_pin";
      const buildingGeometry = await getBuildingGeometry(
        verifiedDestination.placeId,
      );
      if (
        buildingGeometry &&
        usesBuildingEntrances(
          verifiedDestination.placeId,
          verifiedDestination.types,
          buildingGeometry,
        )
      ) {
        besideBuilding = isBesideBuilding(
          { lat, lng },
          buildingGeometry.outlines,
          gpsAccuracyMeters,
        );
        const nearestEntrance = selectNearestEntrance(
          { lat, lng },
          buildingGeometry.entrances,
        );
        if (nearestEntrance) {
          targetLocation = nearestEntrance.entrance.location;
          entranceLocation = targetLocation;
          entranceSource = "geocoding_entrance";
          destinationDistanceMeters = nearestEntrance.distanceMeters;
        }
        dataSources.add("google_building_entrances");
        testSteps.push({
          name: "building_entrances",
          prompt:
            "Use the Google Geocoding building entrance nearest the user instead of the single map pin.",
          response:
            (nearestEntrance
              ? `NEAREST_ENTRANCE: ${Math.round(nearestEntrance.distanceMeters)} meters ` +
                `(${buildingGeometry.entrances.length} listed)`
              : "NO_ENTRANCES_LISTED") +
            (besideBuilding ? "; USER_BESIDE_BUILDING" : ""),
          model: "google-geocoding",
          success: nearestEntrance !== null,
        });
      }

      const closedNotice =
        verifiedDestination.businessStatus === "CLOSED_TEMPORARILY"
          ? buildClosedNowNotice(verifiedDestination.placeName, true)
          : verifiedDestination.openNow === false
            ? buildClosedNowNotice(verifiedDestination.placeName)
            : "";

      destinationBearing = calculateHeading({ lat, lng }, targetLocation);
      if (typeof deviceHeading === "number") {
        headingDifferenceDegrees = lastMileHeadingDifference(
          deviceHeading,
          destinationBearing,
        );
        headingAligned = isLastMileHeadingAligned(
          deviceHeading,
          destinationBearing,
        );
        testSteps.push({
          name: "heading_alignment",
          prompt:
            "Compare the phone compass heading with the verified destination bearing.",
          response:
            `${headingAligned ? "ALIGNED" : "MISALIGNED"}: phone ` +
            `${deviceHeading.toFixed(1)} degrees, destination ` +
            `${destinationBearing.toFixed(1)} degrees, difference ` +
            `${headingDifferenceDegrees.toFixed(1)} degrees`,
          model: "deterministic-compass",
          success: true,
        });
      }

      dataSources.add("phone_gps");
      if (typeof deviceHeading === "number") dataSources.add("phone_compass");

      // Constants so the fallback closure below keeps the narrowed types.
      const place = verifiedDestination;
      const distanceMeters = destinationDistanceMeters;
      const bearing = destinationBearing;
      const gate = guidancePolicy.analysisGate(distanceMeters, gpsAccuracyMeters);
      gpsAllowanceMeters = gate.allowanceMeters;
      exactGateWidened = gate.widened;

      if (headingAligned && !gate.exact) {
        navigationMode = "aligned";
        testScenario = "heading_aligned";
        testSteps.push({
          name: "proximity_gate",
          prompt: proximityPrompt,
          response: `APPROACH_ONLY: ${Math.round(distanceMeters)} meters`,
          model: "google-places",
          success: true,
        });
        const finalOutput =
          `${place.placeName}, ${place.placeAddress}, is approximately ${Math.round(distanceMeters)} meters away in a straight line. A walking route has not been verified. Use your primary walking navigation before trying Last Meters closer to the destination.` +
          closedNotice +
          buildLastMileSourceNote(null);
        const testLogId = await recordTrial({ finalOutput, success: true });
        return respond(200, {
          output: finalOutput,
          testLogId,
          mode: navigationMode,
          testScenario,
          warning: "heading_already_aligned",
        }, saveBackgroundPanorama(testLogId, panoramaDownload));
      }

      if (!gate.exact) {
        navigationMode = "approach";
        testScenario = "test_b_approach";
        const finalOutput =
          `${place.placeName}, ${place.placeAddress}, is approximately ${Math.round(distanceMeters)} meters away in a straight line. A walking route has not been verified. Use your primary walking navigation before trying Last Meters closer to the destination.` +
          closedNotice +
          buildLastMileSourceNote(null);
        testSteps.push({
          name: "proximity_gate",
          prompt: proximityPrompt,
          response:
            `APPROACH_ONLY: ${Math.round(distanceMeters)} meters, ` +
            `${bearing.toFixed(1)} degrees`,
          model: "google-places",
          success: true,
        });
        const testLogId = await recordTrial({ finalOutput, success: true });
        return respond(200, {
          output: finalOutput,
          testLogId,
          mode: navigationMode,
          testScenario,
          warning: "destination_too_far",
        }, saveBackgroundPanorama(testLogId, panoramaDownload));
      }

      navigationMode = "exact";
      testSteps.push({
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

      /**
       * Preserve the recorded failure context without converting a map pin
       * into a visually verified entrance or a precise turn.
       */
      const respondWithPlacesFallback = async (fallback: {
        imageryNote: string;
        error: string;
        reason: string;
      }) => {
        return withhold([fallback.error], `Google Maps places ${place.placeName} about ${formatLastMileDistance(distanceMeters)} away, but the entrance is not visually verified. I will not give a precise turn. Use your primary navigation or ask for assistance.`);
      };

      activeStage = "panorama download";
      let panorama: Awaited<typeof panoramaDownload>;
      try {
        panorama = await panoramaDownload;
      } catch (panoramaError: any) {
        testScenario = "no_panorama";
        panoramaStatus =
          typeof panoramaError?.code === "string"
            ? panoramaError.code
            : "STREET_VIEW_UNAVAILABLE";
        testSteps.push({
          name: "panorama_download",
          prompt:
            "Fetch an outdoor Google Street View panorama at the user's position.",
          response: panoramaStatus,
          model: "google-street-view",
          success: false,
          error:
            panoramaError instanceof Error
              ? panoramaError.message
              : "Street View was unavailable.",
        });
        const finalOutput = `You are about ${formatLastMileDistance(distanceMeters)} from ${place.placeName}. ` +
          "I could not verify a suitable outdoor panorama, so I cannot safely provide a precise turn or entrance direction. " +
          "Stay in a safe place and use your primary navigation or ask for assistance." + closedNotice + buildLastMileSourceNote(null);
        const testLogId = await recordTrial({ finalOutput, success: false, error: "no_validated_outdoor_panorama" });
        return respond(200, { output: finalOutput, testLogId, mode: navigationMode, testScenario,
          currentHeading, targetHeading: null, warning: "no_validated_outdoor_panorama" });
      }
      let targetHeading: number | null = null;
      let targetBearing: number | undefined;
      let visualMatchAgreesWithMap = false;
      for (let matchingAttempt = 0; matchingAttempt < 3; matchingAttempt++) {
      const tryNextPanorama = async (): Promise<boolean> => {
        // An original-panorama retry must not move on to a different panorama.
        if (pinnedPanorama || matchingAttempt >= 2 || panoramaBudget.seen.size >= 3 || Date.now() >= panoramaBudget.deadline) return false;
        auditPanorama({ panoId: panorama.metadata.pano_id, status: "destination_not_visible",
          reason: "Destination matching failed; trying a distinct nearby outdoor panorama." });
        try {
          const next = await processPanoramaTiles(lat, lng, classifyPanorama, auditPanorama, panoramaBudget);
          panorama = next;
          return true;
        } catch { return false; }
      };
      destinationReferenceUsed = false;
      destinationPhoto = undefined;
      destinationPhotoDate = undefined;
      destinationPhotoStatus = undefined;
      signText = undefined;
      signTextMatched = undefined;
      targetBearing = undefined;
      dataSources.add("street_view_panorama");
      const { tiles } = panorama;
      panoramaDate = panorama.metadata.date;
      panoramaStatus = panorama.metadata.status;
      panoId = panorama.metadata.pano_id;
      panoramaCopyright = panorama.metadata.copyright;
      panoramaAgeYears = streetViewImageryAgeYears(panoramaDate);
      panoramaHeadings = tiles.map((tile) => tile.heading);
      const panoramaOrigin = panorama.metadata.location ?? { lat, lng };
      const panoramaTargetBearing = calculateHeading(
        panoramaOrigin,
        targetLocation,
      );
      const expectedTargetHeading = snapLastMileHeading(panoramaTargetBearing);
      activeStage = "panorama assembly";
      panoramaPhoto = await buildPanoramaDebugImage(tiles);
      const panoramaOverviewMsg: any[] = [];
      tiles.forEach((tile) => {
        const label = {
          type: "text",
          text: `--- PANORAMA IMAGE AT ${tile.heading}° ---`,
        };
        panoramaOverviewMsg.push(label);
        panoramaOverviewMsg.push({
          type: "image_url",
          image_url: { url: tile.base64, detail: "low" },
        });
      });

      console.log(
        `\n🤖 Running 3-Step Architecture for target: [${destination}]...`,
      );

      // ==========================================
      // STEP 1: FIND USER HEADING (User Photo + Panorama)
      // ==========================================
      activeStage = "current-view matching";
      console.log("   ➤ Step 1: Locating User's Current View...");
      const step1Prompt = `You will receive ${LAST_MILE_HEADINGS.length} distinct, non-overlapping panorama images labeled with their center headings at ${LAST_MILE_PANORAMA_FOV_DEGREES}-degree intervals, followed by a user's photo. Identify which single panorama segment confidently matches the center of the user's photo. Compare stable building geometry, windows, and street layout; do not rely on a repeated chain-store logo alone. Return NOT_VISIBLE for indoor imagery or ambiguous matches across multiple directions.
Reply with exactly one heading token: ${LAST_MILE_HEADINGS.join(", ")}, or NOT_VISIBLE. Do not reply with the VIEW number.
Use NOT_VISIBLE when the photo is blurry, blank, obstructed, or cannot be confidently matched. Do not return business names or explanations.`;
      const panoramaDateContext = panoramaDate
        ? `Street View reports that this panorama was captured in ${panoramaDate}.`
        : "Street View did not provide a capture date for this panorama.";
      const destinationLabel =
        place.placeName.toLowerCase() === destinationQuery.toLowerCase()
          ? `"${place.placeName}"`
          : `"${place.placeName}" (requested as "${destinationQuery}")`;
      const step2Prompt = `You will receive ${LAST_MILE_HEADINGS.length} distinct, non-overlapping panorama views labeled with their center headings. Find the storefront, sign, or entrance for ${destinationLabel}. ${panoramaDateContext}
      Google Maps places the verified destination near ${expectedTargetHeading} degrees from the panorama camera. Inspect that view and both neighboring views carefully, but use the map bearing only to focus the search, never as proof that the storefront is visible.
      If the primary name text is partially obscured by a canopy, tree, or awning, look carefully at side banners, architectural markers, or window logos before deciding it is NOT_VISIBLE.
      Reply with exactly one heading token: ${LAST_MILE_HEADINGS.join(", ")}, or NOT_VISIBLE. Do not reply with the VIEW number. Return NOT_VISIBLE for indoor imagery.
      Use NOT_VISIBLE unless the requested destination is clearly identifiable in the panorama. A different nearby business is not a match. Do not infer a current business from nearby stores, an old sign, or the destination name alone.`;
      const step2StartedAt = Date.now();
      const step2Request = getOpenAIClient().chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: step2Prompt },
          {
            role: "user",
            content: [
              ...panoramaOverviewMsg,
            ],
          },
        ],
        temperature: 0.0,
        max_tokens: 12,
      }).then(response => ({ response, durationMs: Date.now() - step2StartedAt }));
      // Observe errors even if a compass conflict returns before Step 2 is used.
      void step2Request.catch(() => undefined);
      const step1StartedAt = Date.now();
      const step1Response = await getOpenAIClient().chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: step1Prompt },
          {
            role: "user",
            content: [
              ...panoramaOverviewMsg,
              { type: "text", text: "--- USER'S CURRENT PHOTO ---" },
              { type: "image_url", image_url: { url: image, detail: "low" } },
            ],
          },
        ],
        temperature: 0.0,
        max_tokens: 12,
      });
      const step1Text = step1Response.choices[0].message.content?.trim() || "";
      const comparison = compareCompassAndPanoramaHeadings(
        deviceHeading,
        parseLastMileHeading(step1Text),
      );
      compassHeading = comparison.compassHeading ?? undefined;
      panoramaMatchedHeading = comparison.panoramaMatchedHeading ?? undefined;
      headingComparisonDifference = comparison.differenceDegrees;
      headingComparisonAgrees = comparison.agrees;
      currentHeading = comparison.authoritativeHeading ?? undefined;
      testSteps.push({
        name: "panorama_current_view_match",
        panoId,
        durationMs: Date.now() - step1StartedAt,
        prompt: step1Prompt,
        response: step1Text,
        parsedHeading: panoramaMatchedHeading,
        model: "gpt-4o-mini",
        success: panoramaMatchedHeading !== undefined,
        error:
          panoramaMatchedHeading === undefined
            ? "Panorama could not independently match the current view."
            : undefined,
        tokenCount: step1Response.usage?.total_tokens,
      });
      testSteps.push({
        name: "compass_current_heading",
        prompt:
          "Record the phone compass heading independently. This is the only source permitted to control turn direction.",
        response:
          compassHeading === undefined
            ? "COMPASS_UNAVAILABLE"
            : `${compassHeading} DEG`,
        parsedHeading: compassHeading,
        model: "device-compass",
        success: compassHeading !== undefined,
        error:
          compassHeading === undefined
            ? "Phone compass heading was unavailable."
            : undefined,
      });
      testSteps.push({
        name: "heading_source_comparison",
        prompt:
          "Compare the independent compass and panorama headings without changing navigation guidance.",
        response:
          headingComparisonDifference === undefined
            ? "NOT_COMPARABLE"
            : `${headingComparisonAgrees ? "AGREE" : "DISAGREE"}: ` +
              `${headingComparisonDifference} DEG DIFFERENCE`,
        model: "deterministic-comparison",
        success: headingComparisonAgrees === true,
        error:
          headingComparisonDifference === undefined
            ? "Both heading sources were not available."
            : undefined,
      });
      if (currentHeading === undefined) {
        const finalOutput = guidancePolicy.withheldMessage(["current_heading_unavailable"],
          "Your phone compass was unavailable or not calibrated, so I will not calculate a turn. " +
          "Stay where you are, move the phone in a slow figure eight to recalibrate the compass, then take a new photo.", trialContext());
        const testLogId = await recordTrial({
          finalOutput,
          success: false,
          error: "compass_heading_unavailable",
        });
        return respond(200, {
          output: finalOutput,
          testLogId,
          mode: navigationMode,
          testScenario,
          warning: "compass_heading_unavailable",
        });
      }

      if (headingComparisonAgrees === false) {
        testScenario = "heading_conflict";
        confidenceLevel = "low";
        safetyReasons = ["heading_sources_disagree"];
        const finalOutput =
          buildHeadingConflictInstruction(place.placeName, distanceMeters) +
          closedNotice +
          buildLastMileSourceNote(panoramaDate);
        const testLogId = await recordTrial({
          finalOutput,
          success: false,
          error: "heading_sources_disagree",
        });
        return respond(200, {
          output: finalOutput,
          testLogId,
          mode: navigationMode,
          testScenario,
          currentHeading,
          confidenceLevel: "low",
          warning: "heading_sources_disagree",
        });
      }

      // ==========================================
      // STEP 2: FIND TARGET HEADING (Text Name + Panorama ONLY - NO USER PHOTO)
      // ==========================================
      activeStage = "destination matching";
      console.log("   ➤ Step 2: Locating Target Store...");
      const { response: step2Response, durationMs: step2DurationMs } = await step2Request;
      const step2Text = step2Response.choices[0].message.content?.trim() || "";
      const visuallyMatchedTargetHeading = parseLastMileHeading(step2Text);
      targetHeading = resolveVerifiedTargetHeading(
        visuallyMatchedTargetHeading,
        expectedTargetHeading,
      );
      visualMatchAgreesWithMap = targetHeading !== null;
      if (visualMatchAgreesWithMap) {
        testScenario = "test_a_visible";
        panoramaTargetHeading = targetHeading ?? undefined;
        targetBearing = destinationBearing;
      }
      testSteps.push({
        name: "target_store_match",
        panoId,
        durationMs: step2DurationMs,
        prompt: step2Prompt,
        response: step2Text,
        parsedHeading: targetHeading ?? undefined,
        model: "gpt-4o-mini",
        success: visualMatchAgreesWithMap,
        error:
          visuallyMatchedTargetHeading === null
            ? "Destination was not visible in the panorama."
            : visualMatchAgreesWithMap
              ? undefined
              : "Visual destination heading disagreed with the verified map bearing.",
        tokenCount: step2Response.usage?.total_tokens,
      });
      if (targetHeading === null) {
        if (!shouldUseDestinationReference(distanceMeters)) {
          if (await tryNextPanorama()) continue;
          // Beside a large building the door in front of the user may be
          // real; "not visible from this block" would send them away from it.
          if (besideBuilding) {
            return respondWithPlacesFallback({
              imageryNote: "",
              error: "entrance_not_visually_confirmed",
              reason: "ENTRANCE_NOT_VISUALLY_CONFIRMED",
            });
          }
          navigationMode = "approach";
          testScenario = "test_b_approach";
          const finalOutput =
            `I could not visually confirm ${place.placeName}. The map places it approximately ${Math.round(distanceMeters)} meters away in a straight line, but a walking route has not been verified. Stay in a safe place and use your primary walking navigation or ask for assistance.` +
            closedNotice +
            buildLastMileSourceNote(panoramaDate);
          const testLogId = await recordTrial({ finalOutput, success: true });
          return respond(200, {
            output: finalOutput,
            testLogId,
            mode: navigationMode,
            testScenario,
            currentHeading,
            targetHeading,
            warning: "destination_not_visible_move_closer",
          });
        }

        testScenario = "test_a_reference";
        activeStage = "destination reference lookup";
        console.log(
          "   Step 2B: Fetching a destination-focused Street View reference...",
        );
        const referencePrompt =
          `Fetch a Street View image aimed at the verified nearby location for ${destinationLabel}, ` +
          "then confirm the destination in that image.";
          const signPrompt = `You will receive two zoomed Street View images of storefronts.
Transcribe the business names and sign text you can actually read, one per line.
Do not guess letters you cannot read and do not add names that are not clearly visible.
If no sign text is readable, reply exactly: NO_TEXT.`;
        const signWork = (async () => {
            const closeUps = await fetchSignCloseUps(
              panorama.metadata,
              lat,
              lng,
              panoramaTargetBearing,
            );
            dataSources.add("street_view_sign_closeup");
            return getOpenAIClient().chat.completions.create({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: signPrompt },
                {
                  role: "user",
                  content: closeUps.flatMap((url, index) => [
                    { type: "text" as const, text: `--- CLOSE-UP ${index + 1} ---` },
                    {
                      type: "image_url" as const,
                      image_url: { url, detail: "high" as const },
                    },
                  ]),
                },
              ],
              temperature: 0.0,
              max_tokens: 80,
            });
        })();
        void signWork.catch(() => undefined);
        if (!shouldUseDestinationReference(distanceMeters, panoramaAgeYears)) {
          destinationReferenceUsed = false;
          destinationPhotoStatus = "stale_imagery";
          testSteps.push({ name: "destination_reference_match", prompt: referencePrompt,
            response: "SKIPPED: stale_imagery", model: "deterministic-age-gate", success: false,
            error: "Destination-reference check skipped because the panorama is older than 8 years; sign close-ups remain enabled." });
        } else try {
          const reference = await getDestinationStreetViewReference(
            lat,
            lng,
            destinationQuery,
            { ...place, location: targetLocation, distanceMeters },
            classifyPanorama,
            attempt => auditPanorama({ ...attempt, reason: `Destination reference: ${attempt.reason}` }),
          );
          dataSources.add("street_view_reference");
          destinationPhoto = reference.photo;
          destinationPhotoDate = reference.date;
          destinationPhotoStatus = reference.status;
          destinationPlaceName = reference.placeName;
          destinationPlaceAddress = reference.placeAddress;

          activeStage = "destination reference verification";
          const destinationDateContext = reference.date
            ? `Street View reports that this image was captured in ${reference.date}.`
            : "Street View did not provide a capture date for this image.";
          const step2bPrompt = `You will receive a destination-focused Street View image for the verified nearby place "${reference.placeName}" at "${reference.placeAddress}". ${destinationDateContext}
Reply with exactly one token: VISIBLE or NOT_VISIBLE.
Use VISIBLE only when the storefront, sign, or entrance clearly corresponds to the named destination. Do not infer identity from the prompt, nearby businesses, or a generic building entrance.`;
          const step2bResponse = await getOpenAIClient().chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: step2bPrompt },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "--- DESTINATION-FOCUSED STREET VIEW ---",
                  },
                  {
                    type: "image_url",
                    image_url: { url: reference.photo, detail: "high" },
                  },
                ],
              },
            ],
            temperature: 0.0,
            max_tokens: 8,
          });
          const step2bText =
            step2bResponse.choices[0].message.content?.trim() || "";
          destinationReferenceUsed = parseDestinationVisibility(step2bText);
          if (destinationReferenceUsed) {
            targetHeading = reference.targetHeading;
            targetBearing = destinationBearing;
          }
          testSteps.push({
            name: "destination_reference_match",
            prompt: step2bPrompt,
            response: step2bText,
            parsedHeading: destinationReferenceUsed
              ? reference.targetHeading
              : undefined,
            model: "gpt-4o-mini",
            success: destinationReferenceUsed,
            error: destinationReferenceUsed
              ? undefined
              : "Destination was not confirmed in the focused Street View image.",
            tokenCount: step2bResponse.usage?.total_tokens,
          });
        } catch (referenceError) {
          const message =
            referenceError instanceof Error
              ? referenceError.message
              : "Destination reference lookup failed.";
          console.error("Destination Street View fallback failed:", message);
          testSteps.push({
            name: "destination_reference_match",
            prompt: referencePrompt,
            model: "google-street-view",
            success: false,
            error: message,
          });
        }

        {
          // Step 2C runs alongside Step 2B; only use its heading if 2B missed.
          // The model is not told the destination name, so it cannot be led
          // into "reading" it; the name comparison happens in code.
          activeStage = "sign text close-up";
          try {
            const signResponse = await signWork;
            signText = signResponse.choices[0].message.content?.trim() || "";
            signTextMatched =
              !/^NO_TEXT$/i.test(signText) &&
              signTextMatchesPlaceName(signText, place.placeName);
            if (signTextMatched && targetHeading === null) {
              testScenario = "test_a_sign_text";
              targetHeading = expectedTargetHeading;
              panoramaTargetHeading = expectedTargetHeading;
              targetBearing = destinationBearing;
            }
            testSteps.push({
              name: "sign_text_match",
            panoId,
              prompt: signPrompt,
              response: signText,
              parsedHeading: signTextMatched ? expectedTargetHeading : undefined,
              model: "gpt-4o-mini",
              success: signTextMatched,
              error: signTextMatched
                ? undefined
                : `No readable sign named ${place.placeName}.`,
              tokenCount: signResponse.usage?.total_tokens,
            });
          } catch (signError) {
            testSteps.push({
              name: "sign_text_match",
              prompt: signPrompt,
              model: "google-street-view",
              success: false,
              error:
                signError instanceof Error
                  ? signError.message
                  : "Sign close-up lookup failed.",
            });
          }
        }
      }
      if (targetHeading === null) {
        if (await tryNextPanorama()) continue;
        return respondWithPlacesFallback({
          imageryNote: panoramaDate
            ? ` The available Street View panorama is dated ${panoramaDate} and may be outdated.`
            : " The available Street View imagery may be outdated.",
          error: "entrance_not_visually_confirmed",
          reason: "ENTRANCE_NOT_VISUALLY_CONFIRMED",
        });
      }

      break;
      }
      if (targetHeading === null || currentHeading === undefined) throw new Error("No verified navigation heading.");
      const confidence = calculateLastMileConfidence({
        gpsAccuracyMeters,
        compassAccuracyLevel,
        panoramaCurrentViewMatched: panoramaMatchedHeading !== undefined,
        compassPanoramaAgrees: headingComparisonAgrees,
        destinationVisuallyMatched: visualMatchAgreesWithMap || signTextMatched === true,
        destinationReferenceVerified: destinationReferenceUsed,
        panoramaAgeYears,
      });
      confidenceScore = confidence.score;
      confidenceLevel = confidence.level;
      confidenceReasons = confidence.reasons;
      testSteps.push({
        name: "confidence_fusion", prompt: "Score independent evidence before the turn safety gate; this is a heuristic, not a calibrated probability.",
        response: `${confidence.level.toUpperCase()}: ${Math.round(confidence.score * 100)}%`,
        model: "deterministic-confidence", success: confidence.level === "high",
        error: confidence.level !== "high" ? confidence.reasons.join(" ") : undefined,
      });
      try {
        const route = await axios.get("https://maps.googleapis.com/maps/api/directions/json", {
          params: { mode: "walking", origin: `${lat},${lng}`, destination: `${targetLocation.lat},${targetLocation.lng}`, key: getGoogleMapsApiKey() }, timeout: 8000,
        });
        walkingEvidence = route.data.status === "OK"
          ? evaluateWalkingLeg(route.data.routes?.[0]?.legs?.[0], { lat, lng }, targetLocation)
          : { verified: false, reason: "walking_route_unavailable" };
      } catch { walkingEvidence = { verified: false, reason: "walking_route_unavailable" }; }
      const turnReasons = guidancePolicy.turnReasons({ confidenceLevel: confidence.level,
        photoMatched: panoramaMatchedHeading !== undefined, headingAgrees: headingComparisonAgrees,
        compassAccuracy: compassAccuracyLevel, gpsAccuracy: gpsAccuracyMeters, distanceMeters,
        entranceListed: entranceSource === "geocoding_entrance",
        visualTargetMatched: visualMatchAgreesWithMap || signTextMatched === true || destinationReferenceUsed,
        walking: walkingEvidence, sensorReasons: guidancePolicy.turnSensorReasons(sensors, { lat, lng }, deviceHeading, gpsAccuracyMeters, safetyNow(), evaluationTime) });
      if (turnReasons.length) return withhold(turnReasons, "I cannot verify the entrance and your orientation well enough for a precise turn. Stay in a safe place and use your primary walking navigation or ask for assistance. Entrance accessibility has not been verified.");
      // Visual bearings remain camera-origin evidence. Guidance uses phone-origin geometry.
      currentHeading = guidanceHeading ?? currentHeading;
      targetHeading = destinationBearing;
      targetBearing = destinationBearing;

      // ==========================================
      // TYPESCRIPT MATH CALCULATION (Bulletproof Turn Logic)
      // ==========================================
      const turnInstruction = buildLastMileTurnInstruction(
        guidanceHeading ?? currentHeading,
        targetBearing ?? targetHeading,
      );
      const distanceSentence = buildLastMileDistanceSentence(
        place.placeName,
        distanceMeters,
        !turnInstruction.startsWith("No turn"),
      );

      // ==========================================
      // STEP 3: ACCESSIBLE GUIDANCE & LANDMARKS
      // ==========================================
      activeStage = "accessible guidance";
      console.log("   ➤ Step 3: Generating Accessible Guidance...");
      const destinationReferenceContext = destinationReferenceUsed
        ? `A separate Street View image for "${destinationPlaceName}" is also provided. It was captured ${destinationPhotoDate || "on an unknown date"} and may be outdated. Use it only as historical entrance context, never as proof of current conditions.`
        : "No separate destination reference image is provided.";
      const step3Prompt = `You are an orientation assistant for a blind pedestrian.
The validated turn instruction is: "${turnInstruction}"
${destinationReferenceContext}
Describe at most two stable physical landmarks. Use the user's current photo for a landmark useful while turning in place. If a destination reference is provided, you may also describe one clearly visible entrance feature and must prefix it with "Street View reference:".
Only mention stable, cane-detectable or tactile features such as a wall edge, curb, doorway recess, railing, or steps.
Do not name, describe, or direct the user toward any business other than "${destinationPlaceName || destination}". If the requested destination's entrance is not verified, omit entrance guidance rather than substituting a neighboring storefront.
Never claim that a reference-image feature is currently present or visible from the user's position. Never invent an object. Never say "look", "see", "watch", "keep an eye out", or promise that a path is clear.
Do not instruct the user to walk forward or cross a street. If no reliable landmark is visible, reply exactly: NO_RELIABLE_LANDMARKS.
Keep the response to two short sentences and do not repeat the turn instruction.` + (guidancePolicy.landmarkContext ?? "");
      const step3UserContent: any[] = [
        { type: "text", text: "--- USER'S CURRENT PHOTO ---" },
        { type: "image_url", image_url: { url: image, detail: "high" } },
      ];
      if (destinationReferenceUsed && destinationPhoto) {
        step3UserContent.push(
          {
            type: "text",
            text: "--- DESTINATION-FOCUSED STREET VIEW REFERENCE ---",
          },
          {
            type: "image_url",
            image_url: { url: destinationPhoto, detail: "high" },
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
      testSteps.push({
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
        `- 1st Match (Current View): The user is facing ${currentHeading}°.`,
      );
      console.log(
        `- 2nd Match (Target Store): The target '${destination}' is located at ${targetHeading}°.`,
      );
      console.log(
        `- 3rd Step (Guidance): ${turnInstruction} Landmarks: ${landmarksGuidance}`,
      );
      console.log("=========================================\n");

      const lateReasons = guidancePolicy.turnSensorReasons(sensors, { lat, lng }, deviceHeading, gpsAccuracyMeters, safetyNow(), evaluationTime);
      if (lateReasons.length) return withhold(lateReasons);
      const finalOutput = guidancePolicy.finalOutput({
        turnInstruction, distanceSentence, landmarksGuidance, closedNotice, panoramaDate, walkingEvidence,
      });
      const testLogId = await recordTrial({
        finalOutput,
        success: true,
        targetHeading,
        turnInstruction,
      });
      return respond(200, {
        output: finalOutput,
        testLogId,
        mode: navigationMode,
        testScenario,
        currentHeading,
        targetHeading,
        confidenceLevel,
        confidenceScore,
      });
    } catch (error: any) {
      const upstreamStatus = error?.status ?? error?.response?.status;
      const failureReason =
        typeof upstreamStatus === "number"
          ? `upstream returned HTTP ${upstreamStatus}`
          : typeof error?.code === "string"
            ? error.code
            : "unexpected backend error";
      const clientError = `Last Meters failed during ${activeStage}: ${failureReason}.`;
      console.error("❌ Last Meters request failed:", {
        stage: activeStage,
        status: upstreamStatus,
        code: error?.code,
        message: error?.message,
      });
      await recordTrial({
        success: false,
        error: error?.message ?? "Last meters calculation failed.",
      });
      return respond(502, { error: clientError });
    }
  }
}

async function resizeDataUrlImage(
  dataUrl: string,
  maxWidth: number,
  quality: number,
): Promise<string> {
  try {
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const outputBuffer = await sharp(Buffer.from(base64Data, "base64"))
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    return `data:image/jpeg;base64,${outputBuffer.toString("base64")}`;
  } catch (error) {
    console.error(
      "[LastMileTestLog] failed to compress user photo for storage:",
      error,
    );
    return dataUrl;
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
