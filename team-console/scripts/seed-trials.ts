// The Trials scripts/local-stack.ts loads into its throwaway Mongo: one of each case
// the console handles, including Trials saved in older shapes. Written as extended
// JSON for mongoimport, so ids and dates keep their Mongo types.

/** The seeded Trials the e2e tests open by id. */
export const SEEDED = {
  /** CVS, with a fresh and an original-panorama retry. */
  original: "6720f1c2a1b2c3d4e5f60718",
  freshRetry: "6720f1c2a1b2c3d4e5f60719",
  originalRetry: "6720f1c2a1b2c3d4e5f6071a",
  /** Duane Reade, reviewed before outcome scoring: only reviewerStatus "pass". */
  reviewedBeforeOutcomes: "6720f1c2a1b2c3d4e5f6071b",
  /** Best Buy Express, saved with values the console's schema no longer defines. */
  olderShape: "6720f1c2a1b2c3d4e5f6071c",
  // The ones below are unscored, and only e2e/reviews.spec.ts writes to them.
  /** Kohl's, with notes and a turn a quick score must keep. */
  quickScored: "6720f1c2a1b2c3d4e5f6071d",
  /** Old Navy, reviewed through the detail. */
  detailReviewed: "6720f1c2a1b2c3d4e5f6071e",
  /** Staples, whose saves the test makes fail. */
  failedSave: "6720f1c2a1b2c3d4e5f6071f",
  /** Petco, reviewed while its detail is still loading. */
  savedWhileLoading: "6720f1c2a1b2c3d4e5f60720",
  /** Target, which e2e/retries.spec.ts marks as retrying elsewhere. */
  retriedElsewhere: "6720f1c2a1b2c3d4e5f60721",
} as const;

type Doc = Record<string, unknown>;

const id = (hex: string) => ({ $oid: hex });
const at = (iso: string) => ({ $date: iso });

const image = (color: string) =>
  `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="${color}"/><text x="20" y="160" font-size="40" fill="white">${color}</text></svg>`,
  )}`;

const step = (name: string, extra: Doc = {}): Doc => ({
  name,
  prompt: `Prompt for ${name}`,
  model: "gpt-5-mini",
  success: true,
  response: `${name} looked fine`,
  durationMs: 400,
  ...extra,
});

const fullSteps = [
  step("input_classification", { response: "destination" }),
  step("destination_candidates", { response: "CVS Pharmacy at 120 m" }),
  step("proximity_gate", { response: "within 40 m: exact mode" }),
  step("building_entrances", { response: "2 entrances" }),
  step("heading_alignment", { response: "user facing 30 degrees off" }),
  step("panorama_current_view_match", { panoId: "panoA" }),
  step("compass_current_heading"),
  step("heading_source_comparison", { response: "4 degrees apart" }),
  step("target_store_match", { response: "storefront visible on tile 3" }),
  step("confidence_fusion", { response: "high" }),
  step("accessible_guidance", { response: "Red awning, glass doors" }),
];

const base: Doc = {
  lat: 40.7484,
  lng: -73.9857,
  steps: [],
  panoramaHeadings: [],
  latencyMs: 8000,
  success: true,
};

const cases: Doc[] = [
  {
    _id: id(SEEDED.original),
    destination: "CVS",
    destinationPlaceName: "CVS Pharmacy",
    destinationPlaceAddress: "120 W 34th St",
    pipelineVersion: "3.0.0-safety-gated",
    deployedCommit: "4f9c2e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f",
    runKind: "field",
    navigationMode: "exact",
    testScenario: "test_a_visible",
    destinationDistanceMeters: 34.4,
    gpsAccuracyMeters: 8.2,
    panoramaMatchedHeading: 120,
    headingComparisonAgrees: true,
    compassHeading: 116,
    currentHeading: 120,
    panoramaTargetHeading: 210,
    targetHeading: 95,
    confidenceScore: 0.82,
    confidenceLevel: "high",
    confidenceMethod: "heuristic-not-calibrated",
    confidenceReasons: ["GPS is precise.", "Storefront matched."],
    turnInstruction: "Turn right",
    finalOutput: "CVS is about 34 meters ahead on your right.",
    userPhoto: image("steelblue"),
    panoramaPhoto: image("seagreen"),
    destinationPhoto: image("darkorange"),
    panoId: "panoA",
    panoramaDate: "2024-06",
    panoramaAgeYears: 2.4,
    panoramaCopyright: "(c) Google",
    panoramaSource: "pipeline",
    panoramaHeadings: [0, 22.5, 90, 135, 180, 225, 270, 315],
    panoramaValidation: [
      { panoId: "panoZ", status: "rejected", reason: "indoor", distanceMeters: 12 },
      { panoId: "panoA", status: "accepted", reason: "outdoor street", distanceMeters: 9 },
    ],
    placeCandidates: [
      {
        name: "CVS Pharmacy",
        address: "120 W 34th St",
        distanceMeters: 34,
        types: ["pharmacy", "store"],
        relevant: true,
        source: "text_search",
      },
      {
        name: "Duane Reade",
        address: "100 W 33rd St",
        distanceMeters: 80,
        types: ["pharmacy"],
        relevant: false,
        source: "nearby",
      },
    ],
    placesSearches: ["text_search", "nearby"],
    dataSources: ["google_places", "street_view_panorama", "phone_gps", "phone_compass"],
    entranceSource: "geocoding_entrance",
    gpsAllowanceMeters: 15,
    destinationOpenNow: true,
    destinationBusinessStatus: "OPERATIONAL",
    walkingEvidence: { verified: true, reason: "walking_route_direct" },
    safetyReasons: [],
    steps: fullSteps,
    moduleTimingsMs: {
      preCheck: 812.4,
      currentViewMatch: 2210,
      destinationMatch: 3105.6,
      turnDecision: 4,
      guidance: 1290,
    },
    reviewOutcome: "got_there",
    reviewerStatus: "pass",
    turnCorrectness: "correct",
    entranceCorrectness: "correct",
    serverTs: at("2026-11-03T15:04:00Z"),
  },
  {
    _id: id(SEEDED.freshRetry),
    retryOf: SEEDED.original,
    runKind: "replay",
    retryPanoramaMode: "fresh",
    retryDefaultsApplied: ["compass accuracy level 3"],
    destination: "CVS",
    destinationPlaceName: "CVS Pharmacy",
    destinationPlaceAddress: "120 W 34th St",
    pipelineVersion: "3.0.0-safety-gated",
    deployedCommit: "local-unversioned",
    navigationMode: "exact",
    testScenario: "test_a_reference",
    panoId: "panoB",
    panoramaDate: "2025-09",
    panoramaPhoto: image("olivedrab"),
    finalOutput: "CVS is ahead on your right, past the bank.",
    steps: fullSteps,
    reviewOutcome: "needed_retake",
    serverTs: at("2026-11-04T16:00:00Z"),
  },
  {
    _id: id(SEEDED.originalRetry),
    retryOf: SEEDED.original,
    runKind: "replay",
    retryPanoramaMode: "original",
    destination: "CVS",
    destinationPlaceName: "CVS Pharmacy",
    pipelineVersion: "3.0.0-safety-gated",
    navigationMode: "exact",
    testScenario: "test_a_visible",
    panoId: "panoA",
    success: false,
    error: "destination_not_visible",
    safetyReasons: ["visual_target_not_matched"],
    steps: [
      step("target_store_match", { success: false, response: "no storefront" }),
      step("confidence_fusion", { success: false }),
    ],
    serverTs: at("2026-11-05T10:00:00Z"),
  },
  {
    destination: "Target",
    destinationPlaceName: "Target",
    destinationPlaceAddress: "112 W 34th St",
    pipelineVersion: "3.0.0-safety-gated",
    navigationMode: "approach",
    testScenario: "test_b_approach",
    destinationDistanceMeters: 312.2,
    gpsAccuracyMeters: 22,
    steps: [step("proximity_gate", { response: "312 m: approach mode" })],
    turnInstruction: "Head north",
    finalOutput: "Target is 312 meters north.",
    serverTs: at("2026-11-02T03:30:00Z"),
  },
  {
    destination: "Starbucks",
    destinationPlaceName: "Starbucks Reserve",
    destinationPlaceAddress: "61 9th Ave",
    pipelineVersion: "3.0.0-safety-gated",
    navigationMode: "aligned",
    testScenario: "heading_aligned",
    destinationDistanceMeters: 18,
    gpsAccuracyMeters: 55,
    reviewOutcome: "would_not_get_there",
    turnCorrectness: "wrong",
    entranceCorrectness: "wrong",
    userPhoto: image("slategray"),
    serverTs: at("2026-10-28T19:00:00Z"),
  },
  {
    destination: "Joe's Pizza",
    testScenario: "destination_unverified",
    pipelineVersion: "2.9.0",
    success: false,
    error: "destination_not_verified",
    reviewOutcome: "needed_retake",
    steps: [step("destination_candidates", { success: false, response: "no match within 250 m" })],
    serverTs: at("2026-10-27T14:00:00Z"),
  },
  {
    destination: "where is the nearest subway",
    testScenario: "question_routed",
    pipelineVersion: "3.0.0-safety-gated",
    reviewOutcome: "got_there",
    finalOutput: "The 34 St-Herald Sq station is 200 m east.",
    serverTs: at("2026-11-01T12:00:00Z"),
  },
  {
    destination: "Macy's",
    destinationPlaceName: "Macy's",
    destinationPlaceAddress: "151 W 34th St",
    pipelineVersion: "3.0.0-safety-gated",
    testScenario: "no_panorama",
    panoramaStatus: "no_validated_outdoor_panorama",
    panoramaValidation: [
      { panoId: "panoQ", status: "rejected", reason: "indoor mall", distanceMeters: 30 },
    ],
    success: false,
    error: "no_validated_outdoor_panorama",
    reviewOutcome: "would_not_get_there",
    serverTs: at("2026-10-20T15:00:00Z"),
  },
  {
    _id: id(SEEDED.reviewedBeforeOutcomes),
    destination: "Duane Reade",
    destinationPlaceName: "Duane Reade",
    navigationMode: "exact",
    panoramaMatchedHeading: null,
    reviewerStatus: "pass",
    moduleTimingsMs: { step0: 12, moduleB: 19.9, moduleC: 40, moduleD: 2, moduleE: 3 },
    steps: [step("confidence_fusion", { success: false, response: "low" })],
    serverTs: at("2026-09-15T15:00:00Z"),
  },
  {
    _id: id(SEEDED.olderShape),
    destination: "Best Buy Express",
    navigationMode: "exact",
    runKind: "kiosk",
    reviewOutcome: "great",
    gpsAccuracyMeters: "12",
    walkingEvidence: true,
    placesSearches: "text_search",
    placeCandidates: [{ address: "1 Broadway", types: "store" }],
    safetyReasons: ["low_light", 3],
    serverTs: at("2026-09-10T15:00:00Z"),
  },
  {
    destination: "Whole Foods",
    destinationPlaceName: "Whole Foods Market",
    destinationPlaceAddress: "250 7th Ave",
    pipelineVersion: "3.0.0-safety-gated",
    navigationMode: "approach",
    testScenario: "test_b_approach",
    destinationDistanceMeters: 260,
    panoramaSource: "background",
    panoramaPhoto: image("indigo"),
    panoId: "panoBg",
    dataSources: ["google_places", "phone_gps"],
    success: true,
    error: "entrance_not_visually_confirmed",
    steps: [
      step("target_store_match", { success: false, response: "awning hidden" }),
      step("sign_text_match", { success: false, error: "timeout" }),
    ],
    reviewOutcome: "got_there",
    serverTs: at("2026-10-21T15:00:00Z"),
  },
  {
    _id: id(SEEDED.quickScored),
    destination: "Kohl's",
    testScenario: "test_a_visible",
    reviewerNotes: "Door is on the side",
    turnCorrectness: "wrong",
    serverTs: at("2026-11-06T15:00:00Z"),
  },
  {
    _id: id(SEEDED.detailReviewed),
    destination: "Old Navy",
    testScenario: "test_a_visible",
    serverTs: at("2026-11-06T16:00:00Z"),
  },
  {
    _id: id(SEEDED.failedSave),
    destination: "Staples",
    testScenario: "test_a_visible",
    serverTs: at("2026-11-06T17:00:00Z"),
  },
  {
    _id: id(SEEDED.savedWhileLoading),
    destination: "Petco",
    testScenario: "test_a_visible",
    serverTs: at("2026-11-06T18:00:00Z"),
  },
  {
    _id: id(SEEDED.retriedElsewhere),
    destination: "Target",
    testScenario: "test_a_visible",
    serverTs: at("2026-11-06T19:00:00Z"),
  },
];

const places = [
  "Trader Joe's",
  "Chipotle",
  "Apple Store",
  "Best Buy",
  "Barnes & Noble",
  "Walgreens",
  "Sephora",
  "Uniqlo",
  "H&M",
  "Gap",
  "Zara",
  "Nike",
  "Foot Locker",
];
const outcomes = ["got_there", "needed_retake", "would_not_get_there", undefined];

// Enough ordinary Trials to fill the summary's weeks, locations and versions.
const ordinary = places.flatMap((place, i) =>
  Array.from({ length: (i % 4) + 1 }, (_, n) => ({
    destination: place,
    destinationPlaceName: n === 3 ? `${place} Outlet` : place,
    destinationPlaceAddress: `${100 + i} Broadway`,
    pipelineVersion: i % 3 ? "3.0.0-safety-gated" : "2.9.0",
    navigationMode: ["exact", "approach", "aligned"][i % 3],
    testScenario: ["test_a_visible", "test_b_approach", "heading_aligned"][i % 3],
    destinationDistanceMeters: 20 + i * 7,
    gpsAccuracyMeters: 5 + i * 4,
    reviewOutcome: outcomes[(i + n) % 4],
    turnCorrectness: ["correct", "wrong", "no_turn_given"][(i + n) % 3],
    serverTs: at(new Date(Date.UTC(2026, 9, 5 + i * 2, 13 + n)).toISOString()),
  })),
);

export const seededTrials = (): Doc[] =>
  [...cases, ...ordinary].map((trial) => ({ ...base, ...trial }));
