import axios from "axios";
import type OpenAI from "openai";
import {
  buildHeadingConflictInstruction,
  buildLastMetersSourceNote,
  compareCompassAndPanoramaHeadings,
  formatLastMetersDistance,
  LAST_METERS_HEADINGS,
  LAST_METERS_PANORAMA_FOV_DEGREES,
  parseDestinationVisibility,
  parseLastMetersHeading,
  resolveVerifiedTargetHeading,
  shouldUseDestinationReference,
  snapLastMetersHeading,
  streetViewImageryAgeYears,
} from "../utils/lastMetersNavigation";
import { normalizeNearbyPlaceQuery, signTextMatchesPlaceName } from "../utils/nearbyPlaces";
import { outdoorPanoramaRejection } from "../utils/outdoorPanorama";
import type { LastMetersRequestInput } from "../utils/lastMetersReplay";
import { calculateHeading, getGoogleMapsApiKey } from "./googleMaps";
import { getOpenAIClient } from "./openAIClient";
import {
  selectOutdoorPanorama,
  type PanoramaAudit,
  type PanoramaSearchBudget,
  type SceneClassifier,
} from "./outdoorPanoramaSelection";
import {
  buildPanoramaDebugImage,
  fetchSignCloseUps,
  processPanoramaTiles,
  type StreetViewMetadata,
} from "./streetViewPanorama";
import { getVerifiedNearbyDestination, type VerifiedNearbyDestination } from "./verifiedDestination";
import type { LastMetersRunResult } from "./lastMetersService";
import type { GuidanceTarget, LastMetersTrial, StepResult } from "./lastMetersTrial";

/**
 * Matching tries at most this many panoramas at the user's position, and
 * stops searching once the search has looked at this many.
 */
const MAX_PANORAMAS = 3;

type Panorama = Awaited<ReturnType<typeof processPanoramaTiles>>;
type HeadingComparison = ReturnType<typeof compareCompassAndPanoramaHeadings>;
type ContentPart = OpenAI.Chat.ChatCompletionContentPart;

/** The panorama search runLastMeters started at the user's position, which matching can continue. */
export interface PanoramaSearch {
  /** The first panorama, downloading while the entrance lookup runs. */
  first: Promise<Panorama>;
  budget: PanoramaSearchBudget;
  classify: SceneClassifier;
  audit: PanoramaAudit;
  /** An original-panorama retry must not move on to a different panorama. */
  pinned: boolean;
}

/** What panorama heading matching needs to know about the user and where they are going. */
export interface PanoramaMatchingInput {
  request: Pick<LastMetersRequestInput, "lat" | "lng" | "destination" | "deviceHeading">;
  /** The user's photo. */
  image: string;
  destinationQuery: string;
  place: VerifiedNearbyDestination;
  entrance: GuidanceTarget;
  closedNotice: string;
  search: PanoramaSearch;
}

/** The headings panorama matching settled on, and the evidence behind them. */
export interface PanoramaHeadings {
  /** The compass heading, which the panorama's current-view match agreed with or could not check. */
  currentHeading: number;
  comparison: HeadingComparison;
  /** The destination's heading from the panorama camera. */
  targetHeading: number;
  /** Step 2 saw the destination where the map places it. */
  visualMatch: boolean;
  /** Step 2C read the destination's name on a sign. */
  signTextMatched: boolean;
  /** Set only when Step 2B confirmed the destination in the reference photo. */
  reference?: DestinationStreetViewReference;
  /** The panorama the headings were matched in. */
  panorama: Panorama;
}

/** A panorama in which the destination could not be found, so matching may move on to another. */
type PanoramaMatch = StepResult<PanoramaHeadings> | { kind: "destination_not_found"; currentHeading: number };

/**
 * Matches the user's photo and the destination against Street View panoramas
 * at the user's position, moving on to another panorama when the destination
 * is not found, or ends the run when no heading can be verified.
 */
export async function matchPanoramaHeadings(
  trial: LastMetersTrial,
  input: PanoramaMatchingInput,
): Promise<StepResult<PanoramaHeadings>> {
  trial.stage("panorama download");
  let panorama: Panorama;
  try {
    panorama = await input.search.first;
  } catch (panoramaError) {
    return { kind: "exit", result: await answerNoPanorama(trial, input, panoramaError) };
  }
  for (let attempt = 1; ; attempt++) {
    const matched = await matchPanorama(trial, input, panorama);
    if (matched.kind !== "destination_not_found") return matched;
    const next = attempt < MAX_PANORAMAS ? await nextPanorama(input, panorama) : undefined;
    if (!next) {
      return { kind: "exit", result: await answerDestinationNotFound(trial, input, panorama, matched.currentHeading) };
    }
    panorama = next;
  }
}

async function answerNoPanorama(
  trial: LastMetersTrial,
  input: PanoramaMatchingInput,
  panoramaError: unknown,
): Promise<LastMetersRunResult> {
  const { place, entrance, closedNotice } = input;
  const code = (panoramaError as { code?: unknown } | undefined)?.code;
  const panoramaStatus =
    typeof code === "string"
      ? code
      : "STREET_VIEW_UNAVAILABLE";
  trial.note({ testScenario: "no_panorama", missingPanoramaStatus: panoramaStatus });
  trial.step({
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
  const finalOutput = `You are about ${formatLastMetersDistance(entrance.distanceMeters)} from ${place.placeName}. ` +
    "I could not verify a suitable outdoor panorama, so I cannot safely provide a precise turn or entrance direction. " +
    "Stay in a safe place and use your primary navigation or ask for assistance." + closedNotice + buildLastMetersSourceNote(null);
  return await trial.answer({ targetHeading: null, warning: "no_validated_outdoor_panorama" },
    { finalOutput, success: false, error: "no_validated_outdoor_panorama" });
}

/**
 * Records that the destination was not visible in `panorama` and searches for
 * a distinct nearby outdoor panorama, unless the search is pinned or out of budget.
 */
async function nextPanorama(input: PanoramaMatchingInput, panorama: Panorama): Promise<Panorama | undefined> {
  const { request: { lat, lng }, search } = input;
  if (search.pinned || search.budget.seen.size >= MAX_PANORAMAS || Date.now() >= search.budget.deadline) return undefined;
  search.audit({ panoId: panorama.metadata.pano_id, status: "destination_not_visible",
    reason: "Destination matching failed; trying a distinct nearby outdoor panorama." });
  try {
    return await processPanoramaTiles(lat, lng, search.classify, search.audit, search.budget);
  } catch { return undefined; }
}

/** Ends the run when no panorama tried showed the destination. */
async function answerDestinationNotFound(
  trial: LastMetersTrial,
  input: PanoramaMatchingInput,
  panorama: Panorama,
  currentHeading: number,
): Promise<LastMetersRunResult> {
  const { place, entrance, closedNotice } = input;
  const distanceMeters = entrance.distanceMeters;
  // Beside a large building the door in front of the user may be
  // real; "not visible from this block" would send them away from it.
  if (shouldUseDestinationReference(distanceMeters) || entrance.besideBuilding) {
    // Keep the map pin without converting it into a visually verified entrance or a precise turn.
    return await trial.withhold(["entrance_not_visually_confirmed"], `Google Maps places ${place.placeName} about ${formatLastMetersDistance(distanceMeters)} away, but the entrance is not visually verified. I will not give a precise turn. Use your primary navigation or ask for assistance.`);
  }
  trial.note({ navigationMode: "approach", testScenario: "test_b_approach" });
  const finalOutput =
    `I could not visually confirm ${place.placeName}. The map places it approximately ${Math.round(distanceMeters)} meters away in a straight line, but a walking route has not been verified. Stay in a safe place and use your primary walking navigation or ask for assistance.` +
    closedNotice +
    buildLastMetersSourceNote(panorama.metadata.date);
  return await trial.answer({ currentHeading, targetHeading: null, warning: "destination_not_visible_move_closer" },
    { finalOutput, success: true });
}

/** Steps 1 and 2 on one panorama, with the reference photo and sign text backups when the destination is close. */
async function matchPanorama(
  trial: LastMetersTrial,
  input: PanoramaMatchingInput,
  panorama: Panorama,
): Promise<PanoramaMatch> {
  const { request: { lat, lng, destination }, entrance } = input;
  // A new panorama's row shows only its own backups.
  trial.note({ destinationReference: undefined, destinationReferenceUsed: false, signText: undefined });
  trial.source("street_view_panorama");
  const { tiles } = panorama;
  trial.note({ panorama });
  const panoramaDate = panorama.metadata.date;
  const panoId = panorama.metadata.pano_id;
  const panoramaOrigin = panorama.metadata.location ?? { lat, lng };
  const panoramaTargetBearing = calculateHeading(
    panoramaOrigin,
    entrance.location,
  );
  const expectedTargetHeading = snapLastMetersHeading(panoramaTargetBearing);
  trial.stage("panorama assembly");
  trial.note({ panoramaPhoto: await buildPanoramaDebugImage(tiles) });
  const panoramaOverview: ContentPart[] = tiles.flatMap((tile): ContentPart[] => [
    { type: "text", text: `--- PANORAMA IMAGE AT ${tile.heading}° ---` },
    { type: "image_url", image_url: { url: tile.base64, detail: "low" } },
  ]);

  console.log(
    `\n🤖 Running 3-Step Architecture for target: [${destination}]...`,
  );

  trial.stage("current-view matching");
  console.log("   ➤ Step 1: Locating User's Current View...");
  const destinationMatch = startDestinationMatch(input, panoramaOverview, panoramaDate, expectedTargetHeading);
  const current = await matchCurrentView(trial, input, panoramaOverview, panorama);
  if (current.kind === "exit") return current;
  const { comparison, currentHeading } = current.value;

  trial.stage("destination matching");
  console.log("   ➤ Step 2: Locating Target Store...");
  const visualTargetHeading = await readDestinationMatch(trial, destinationMatch, panoId, expectedTargetHeading);
  const found = (targetHeading: number, evidence: Pick<PanoramaHeadings, "visualMatch" | "signTextMatched" | "reference">): PanoramaMatch =>
    ({ kind: "ok", value: { currentHeading, comparison, targetHeading, panorama, ...evidence } });
  if (visualTargetHeading !== null) {
    return found(visualTargetHeading, { visualMatch: true, signTextMatched: false });
  }
  if (!shouldUseDestinationReference(entrance.distanceMeters)) {
    return { kind: "destination_not_found", currentHeading };
  }

  trial.note({ testScenario: "test_a_reference" });
  trial.stage("destination reference lookup");
  console.log(
    "   Step 2B: Fetching a destination-focused Street View reference...",
  );
  const signTextMatch = startSignTextMatch(trial, input, panorama.metadata, panoramaTargetBearing);
  const reference = await matchDestinationReference(trial, input, panorama);
  // Step 2C runs alongside Step 2B; only use its heading if 2B missed.
  trial.stage("sign text close-up");
  const signTextMatched = await readSignTextMatch(trial, input, signTextMatch, panoId, expectedTargetHeading, reference !== undefined);
  if (reference) return found(reference.targetHeading, { visualMatch: false, signTextMatched, reference });
  if (signTextMatched) return found(expectedTargetHeading, { visualMatch: false, signTextMatched });
  return { kind: "destination_not_found", currentHeading };
}

/** How the destination is named in prompts. */
function destinationLabel(input: PanoramaMatchingInput): string {
  const { place, destinationQuery } = input;
  return place.placeName.toLowerCase() === destinationQuery.toLowerCase()
    ? `"${place.placeName}"`
    : `"${place.placeName}" (requested as "${destinationQuery}")`;
}

// ==========================================
// STEP 1: FIND USER HEADING (User Photo + Panorama)
// ==========================================
const currentViewPrompt = `You will receive ${LAST_METERS_HEADINGS.length} distinct, non-overlapping panorama images labeled with their center headings at ${LAST_METERS_PANORAMA_FOV_DEGREES}-degree intervals, followed by a user's photo. Identify which single panorama segment confidently matches the center of the user's photo. Compare stable building geometry, windows, and street layout; do not rely on a repeated chain-store logo alone. Return NOT_VISIBLE for indoor imagery or ambiguous matches across multiple directions.
Reply with exactly one heading token: ${LAST_METERS_HEADINGS.join(", ")}, or NOT_VISIBLE. Do not reply with the VIEW number.
Use NOT_VISIBLE when the photo is blurry, blank, obstructed, or cannot be confidently matched. Do not return business names or explanations.`;

/**
 * Matches the user's photo against the panorama and compares that with the
 * compass, or ends the run when the compass is unavailable or disagrees.
 */
async function matchCurrentView(
  trial: LastMetersTrial,
  input: PanoramaMatchingInput,
  panoramaOverview: ContentPart[],
  panorama: Panorama,
): Promise<StepResult<{ comparison: HeadingComparison; currentHeading: number }>> {
  const { request: { deviceHeading }, image, place, entrance, closedNotice } = input;
  const panoramaDate = panorama.metadata.date;
  const step1StartedAt = Date.now();
  const step1Response = await getOpenAIClient().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: currentViewPrompt },
      {
        role: "user",
        content: [
          ...panoramaOverview,
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
    parseLastMetersHeading(step1Text),
  );
  const compassHeading = comparison.compassHeading ?? undefined;
  const panoramaMatchedHeading = comparison.panoramaMatchedHeading ?? undefined;
  const headingComparisonDifference = comparison.differenceDegrees;
  const headingComparisonAgrees = comparison.agrees;
  const currentHeading = comparison.authoritativeHeading ?? undefined;
  trial.note({ headingComparison: comparison, currentHeading });
  trial.step({
    name: "panorama_current_view_match",
    panoId: panorama.metadata.pano_id,
    durationMs: Date.now() - step1StartedAt,
    prompt: currentViewPrompt,
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
  trial.step({
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
  trial.step({
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
    const finalOutput = trial.withheldMessage(["current_heading_unavailable"],
      "Your phone compass was unavailable or not calibrated, so I will not calculate a turn. " +
      "Stay where you are, move the phone in a slow figure eight to recalibrate the compass, then take a new photo.");
    return {
      kind: "exit",
      result: await trial.answer({ warning: "compass_heading_unavailable" }, {
        finalOutput,
        success: false,
        error: "compass_heading_unavailable",
      }),
    };
  }

  if (headingComparisonAgrees === false) {
    trial.note({
      testScenario: "heading_conflict",
      confidence: { level: "low" },
      safetyReasons: ["heading_sources_disagree"],
    });
    const finalOutput =
      buildHeadingConflictInstruction(place.placeName, entrance.distanceMeters) +
      closedNotice +
      buildLastMetersSourceNote(panoramaDate);
    return {
      kind: "exit",
      result: await trial.answer({ currentHeading, confidenceLevel: "low", warning: "heading_sources_disagree" }, {
        finalOutput,
        success: false,
        error: "heading_sources_disagree",
      }),
    };
  }
  return { kind: "ok", value: { comparison, currentHeading } };
}

// ==========================================
// STEP 2: FIND TARGET HEADING (Text Name + Panorama ONLY - NO USER PHOTO)
// ==========================================
function destinationPrompt(input: PanoramaMatchingInput, panoramaDate: string | undefined, expectedTargetHeading: number): string {
  const panoramaDateContext = panoramaDate
    ? `Street View reports that this panorama was captured in ${panoramaDate}.`
    : "Street View did not provide a capture date for this panorama.";
  return `You will receive ${LAST_METERS_HEADINGS.length} distinct, non-overlapping panorama views labeled with their center headings. Find the storefront, sign, or entrance for ${destinationLabel(input)}. ${panoramaDateContext}
      Google Maps places the verified destination near ${expectedTargetHeading} degrees from the panorama camera. Inspect that view and both neighboring views carefully, but use the map bearing only to focus the search, never as proof that the storefront is visible.
      If the primary name text is partially obscured by a canopy, tree, or awning, look carefully at side banners, architectural markers, or window logos before deciding it is NOT_VISIBLE.
      Reply with exactly one heading token: ${LAST_METERS_HEADINGS.join(", ")}, or NOT_VISIBLE. Do not reply with the VIEW number. Return NOT_VISIBLE for indoor imagery.
      Use NOT_VISIBLE unless the requested destination is clearly identifiable in the panorama. A different nearby business is not a match. Do not infer a current business from nearby stores, an old sign, or the destination name alone.`;
}

type DestinationMatch = ReturnType<typeof startDestinationMatch>;

/** Starts Step 2 so it runs while Step 1 is awaited. */
function startDestinationMatch(
  input: PanoramaMatchingInput,
  panoramaOverview: ContentPart[],
  panoramaDate: string | undefined,
  expectedTargetHeading: number,
) {
  const prompt = destinationPrompt(input, panoramaDate, expectedTargetHeading);
  const startedAt = Date.now();
  const request = getOpenAIClient().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: prompt },
      {
        role: "user",
        content: [
          ...panoramaOverview,
        ],
      },
    ],
    temperature: 0.0,
    max_tokens: 12,
  }).then(response => ({ response, durationMs: Date.now() - startedAt }));
  // Observe errors even if a compass conflict returns before Step 2 is used.
  void request.catch(() => undefined);
  return { prompt, request };
}

/** The destination's heading when Step 2 saw it where the map places it. */
async function readDestinationMatch(
  trial: LastMetersTrial,
  destinationMatch: DestinationMatch,
  panoId: string | undefined,
  expectedTargetHeading: number,
): Promise<number | null> {
  const { response: step2Response, durationMs: step2DurationMs } = await destinationMatch.request;
  const step2Text = step2Response.choices[0].message.content?.trim() || "";
  const visuallyMatchedTargetHeading = parseLastMetersHeading(step2Text);
  const targetHeading = resolveVerifiedTargetHeading(
    visuallyMatchedTargetHeading,
    expectedTargetHeading,
  );
  const visualMatchAgreesWithMap = targetHeading !== null;
  if (visualMatchAgreesWithMap) {
    trial.note({ testScenario: "test_a_visible", panoramaTargetHeading: targetHeading ?? undefined });
  }
  trial.step({
    name: "target_store_match",
    panoId,
    durationMs: step2DurationMs,
    prompt: destinationMatch.prompt,
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
  return targetHeading;
}

// ==========================================
// STEP 2B: DESTINATION REFERENCE PHOTO
// ==========================================
interface DestinationStreetViewReference {
  photo: string;
  date?: string;
  status: string;
  placeName: string;
  placeAddress: string;
  targetHeading: number;
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
    targetHeading: snapLastMetersHeading(
      calculateHeading(
        { lat, lng },
        { lat: placeLocation.lat, lng: placeLocation.lng },
      ),
    ),
  };
}

function destinationReferencePrompt(reference: DestinationStreetViewReference): string {
  const destinationDateContext = reference.date
    ? `Street View reports that this image was captured in ${reference.date}.`
    : "Street View did not provide a capture date for this image.";
  return `You will receive a destination-focused Street View image for the verified nearby place "${reference.placeName}" at "${reference.placeAddress}". ${destinationDateContext}
Reply with exactly one token: VISIBLE or NOT_VISIBLE.
Use VISIBLE only when the storefront, sign, or entrance clearly corresponds to the named destination. Do not infer identity from the prompt, nearby businesses, or a generic building entrance.`;
}

/** The reference photo aimed at the destination, when Step 2B confirms the destination in it. */
async function matchDestinationReference(
  trial: LastMetersTrial,
  input: PanoramaMatchingInput,
  panorama: Panorama,
): Promise<DestinationStreetViewReference | undefined> {
  const { request: { lat, lng }, destinationQuery, place, entrance, search } = input;
  const referencePrompt =
    `Fetch a Street View image aimed at the verified nearby location for ${destinationLabel(input)}, ` +
    "then confirm the destination in that image.";
  if (!shouldUseDestinationReference(entrance.distanceMeters, streetViewImageryAgeYears(panorama.metadata.date))) {
    trial.note({ destinationReference: { status: "stale_imagery" }, destinationReferenceUsed: false });
    trial.step({ name: "destination_reference_match", prompt: referencePrompt,
      response: "SKIPPED: stale_imagery", model: "deterministic-age-gate", success: false,
      error: "Destination-reference check skipped because the panorama is older than 8 years; sign close-ups remain enabled." });
    return undefined;
  }
  try {
    const reference = await getDestinationStreetViewReference(
      lat,
      lng,
      destinationQuery,
      { ...place, location: entrance.location, distanceMeters: entrance.distanceMeters },
      search.classify,
      attempt => search.audit({ ...attempt, reason: `Destination reference: ${attempt.reason}` }),
    );
    trial.source("street_view_reference");
    trial.note({ destinationReference: reference });

    trial.stage("destination reference verification");
    const step2bPrompt = destinationReferencePrompt(reference);
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
    const destinationReferenceUsed = parseDestinationVisibility(step2bText);
    trial.note({ destinationReferenceUsed });
    trial.step({
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
    return destinationReferenceUsed ? reference : undefined;
  } catch (referenceError) {
    const message =
      referenceError instanceof Error
        ? referenceError.message
        : "Destination reference lookup failed.";
    console.error("Destination Street View fallback failed:", message);
    trial.step({
      name: "destination_reference_match",
      prompt: referencePrompt,
      model: "google-street-view",
      success: false,
      error: message,
    });
    return undefined;
  }
}

// ==========================================
// STEP 2C: SIGN TEXT CLOSE-UPS
// ==========================================
// The model is not told the destination name, so it cannot be led
// into "reading" it; the name comparison happens in code.
const signTextPrompt = `You will receive two zoomed Street View images of storefronts.
Transcribe the business names and sign text you can actually read, one per line.
Do not guess letters you cannot read and do not add names that are not clearly visible.
If no sign text is readable, reply exactly: NO_TEXT.`;

/** Starts Step 2C so it runs while Step 2B is awaited. */
function startSignTextMatch(
  trial: LastMetersTrial,
  input: PanoramaMatchingInput,
  metadata: StreetViewMetadata,
  panoramaTargetBearing: number,
) {
  const { request: { lat, lng } } = input;
  const signWork = (async () => {
    const closeUps = await fetchSignCloseUps(
      metadata,
      lat,
      lng,
      panoramaTargetBearing,
    );
    trial.source("street_view_sign_closeup");
    return getOpenAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: signTextPrompt },
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
  return signWork;
}

/** Whether Step 2C read the destination's name on a sign. */
async function readSignTextMatch(
  trial: LastMetersTrial,
  input: PanoramaMatchingInput,
  signWork: ReturnType<typeof startSignTextMatch>,
  panoId: string | undefined,
  expectedTargetHeading: number,
  referenceUsed: boolean,
): Promise<boolean> {
  const { place } = input;
  try {
    const signResponse = await signWork;
    const signText = signResponse.choices[0].message.content?.trim() || "";
    const signTextMatched =
      !/^NO_TEXT$/i.test(signText) &&
      signTextMatchesPlaceName(signText, place.placeName);
    trial.note({ signText: { text: signText, matched: signTextMatched } });
    if (signTextMatched && !referenceUsed) {
      trial.note({ testScenario: "test_a_sign_text", panoramaTargetHeading: expectedTargetHeading });
    }
    trial.step({
      name: "sign_text_match",
      panoId,
      prompt: signTextPrompt,
      response: signText,
      parsedHeading: signTextMatched ? expectedTargetHeading : undefined,
      model: "gpt-4o-mini",
      success: signTextMatched,
      error: signTextMatched
        ? undefined
        : `No readable sign named ${place.placeName}.`,
      tokenCount: signResponse.usage?.total_tokens,
    });
    return signTextMatched;
  } catch (signError) {
    trial.step({
      name: "sign_text_match",
      prompt: signTextPrompt,
      model: "google-street-view",
      success: false,
      error:
        signError instanceof Error
          ? signError.message
          : "Sign close-up lookup failed.",
    });
    return false;
  }
}
