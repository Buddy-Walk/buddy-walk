import { z } from "zod";

// Shapes of mobile/server's /api/last-meters-tests responses, following
// mobile/server/utils/lastMetersTestRow.ts. Only the fields the console reads
// are listed; zod drops the rest.
//
// Every Trial ever saved must still show, so only the fields mobile/server
// computes for each row are required. A saved field that is absent, null or in
// an older shape reads as missing instead of failing the whole response.

/** A saved field, read as missing when absent, null or in an older shape. */
const maybe = <T extends z.ZodType>(schema: T) =>
  schema
    .nullish()
    .transform((value) => value ?? undefined)
    .optional()
    .catch(undefined);

/** A saved array, leaving out items in an older shape. Absent reads as empty. */
const list = <T extends z.ZodType>(item: T) =>
  z
    .array(z.unknown())
    .transform((values) =>
      values.flatMap((value) => {
        const parsed = item.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    )
    .catch([]);

export const REVIEW_OUTCOMES = ["got_there", "needed_retake", "would_not_get_there"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

// How Trials were reviewed before outcome scoring; "untested" means not reviewed.
export const REVIEWER_STATUSES = ["untested", "pass", "partial", "fail"] as const;
export type ReviewerStatus = (typeof REVIEWER_STATUSES)[number];

export const TURN_CORRECTNESS = ["correct", "wrong", "no_turn_given"] as const;
export type TurnCorrectness = (typeof TURN_CORRECTNESS)[number];
export const ENTRANCE_CORRECTNESS = ["correct", "wrong", "not_identified"] as const;
export type EntranceCorrectness = (typeof ENTRANCE_CORRECTNESS)[number];

export const PANORAMA_MODES = ["fresh", "original"] as const;
export type PanoramaMode = (typeof PANORAMA_MODES)[number];

const stepSchema = z.object({
  name: maybe(z.string()),
  prompt: maybe(z.string()),
  response: maybe(z.string()),
  model: maybe(z.string()),
  success: maybe(z.boolean()),
  error: maybe(z.string()),
  durationMs: maybe(z.number()),
  panoId: maybe(z.string()),
});
export type TrialStep = z.output<typeof stepSchema>;

// Trials logged before the module rename keep the step0 and moduleB-E keys.
const moduleTimingsSchema = z.object({
  preCheck: maybe(z.number()),
  currentViewMatch: maybe(z.number()),
  destinationMatch: maybe(z.number()),
  turnDecision: maybe(z.number()),
  guidance: maybe(z.number()),
  step0: maybe(z.number()),
  moduleB: maybe(z.number()),
  moduleC: maybe(z.number()),
  moduleD: maybe(z.number()),
  moduleE: maybe(z.number()),
});

const panoramaAttemptSchema = z.object({
  panoId: maybe(z.string()),
  status: maybe(z.string()),
  reason: maybe(z.string()),
  distanceMeters: maybe(z.number()),
});

const placeCandidateSchema = z.object({
  name: maybe(z.string()),
  address: maybe(z.string()),
  distanceMeters: maybe(z.number()),
  types: list(z.string()),
  relevant: maybe(z.boolean()),
  source: maybe(z.string()),
});
export type PlaceCandidate = z.output<typeof placeCandidateSchema>;

/** One Trial as the list sends it, without images. */
export const trialSchema = z.object({
  _id: z.string(),
  serverTs: maybe(z.string()),
  createdAt: maybe(z.string()),
  pipelineVersion: maybe(z.string()),
  deployedCommit: maybe(z.string()),
  runKind: maybe(z.enum(["field", "replay"])),
  retryOf: maybe(z.string()),
  retryPanoramaMode: maybe(z.enum(PANORAMA_MODES)),
  retryDefaultsApplied: list(z.string()),
  retryCount: maybe(z.number()),
  safetyReasons: list(z.string()),
  walkingEvidence: maybe(z.object({ reason: maybe(z.string()) })),
  confidenceMethod: maybe(z.string()),

  destination: maybe(z.string()),
  destinationQuery: maybe(z.string()),
  destinationPlaceName: maybe(z.string()),
  destinationPlaceAddress: maybe(z.string()),
  destinationDistanceMeters: maybe(z.number()),
  destinationBearing: maybe(z.number()),
  destinationOpenNow: maybe(z.boolean()),
  destinationBusinessStatus: maybe(z.string()),
  destinationPhotoStatus: maybe(z.string()),
  placesSearches: list(z.string()),
  entranceSource: maybe(z.string()),
  besideBuilding: maybe(z.boolean()),
  lat: maybe(z.number()),
  lng: maybe(z.number()),
  gpsAccuracyMeters: maybe(z.number()),
  gpsAllowanceMeters: maybe(z.number()),
  exactGateWidened: maybe(z.boolean()),
  // Undefined on Trials logged before sources were, which the panorama note tells apart from none.
  dataSources: maybe(z.array(z.string())),

  panoramaStatus: maybe(z.string()),
  panoramaValidation: list(panoramaAttemptSchema),
  panoramaSource: maybe(z.enum(["pipeline", "background"])),
  panoId: maybe(z.string()),
  panoramaDate: maybe(z.string()),
  panoramaCopyright: maybe(z.string()),
  panoramaAgeYears: maybe(z.number()),
  panoramaHeadings: list(z.number()),

  compassHeading: maybe(z.number()),
  panoramaMatchedHeading: maybe(z.number()),
  headingComparisonAgrees: maybe(z.boolean()),
  currentHeading: maybe(z.number()),
  panoramaTargetHeading: maybe(z.number()),
  targetHeading: maybe(z.number()),
  confidenceScore: maybe(z.number()),
  confidenceLevel: maybe(z.string()),
  confidenceReasons: list(z.string()),
  navigationMode: maybe(z.string()),
  testScenario: maybe(z.string()),
  turnInstruction: maybe(z.string()),
  finalOutput: maybe(z.string()),
  steps: list(stepSchema),
  moduleTimingsMs: maybe(moduleTimingsSchema),

  reviewOutcome: maybe(z.enum(REVIEW_OUTCOMES)),
  reviewerStatus: maybe(z.enum(REVIEWER_STATUSES)),
  turnCorrectness: maybe(z.enum(TURN_CORRECTNESS)),
  entranceCorrectness: maybe(z.enum(ENTRANCE_CORRECTNESS)),
  reviewerNotes: maybe(z.string()),

  success: maybe(z.boolean()),
  error: maybe(z.string()),
  latencyMs: maybe(z.number()),

  hasUserPhoto: z.boolean(),
  hasPanorama: z.boolean(),
  hasDestinationPhoto: z.boolean(),
});
export type Trial = z.output<typeof trialSchema>;

/** The original or one of its retries, as the retry history lists them. */
const retryHistoryEntrySchema = z.object({
  id: z.string(),
  serverTs: maybe(z.string()),
  isRetry: z.boolean(),
  panoramaMode: maybe(z.enum(PANORAMA_MODES)),
  defaultsApplied: list(z.string()),
  panoId: maybe(z.string()),
  panoramaDate: maybe(z.string()),
  panoramaSource: maybe(z.enum(["pipeline", "background"])),
  panoramaStatus: maybe(z.string()),
  testScenario: maybe(z.string()),
  success: maybe(z.boolean()),
  error: maybe(z.string()),
  finalOutput: maybe(z.string()),
  reviewOutcome: maybe(z.enum(REVIEW_OUTCOMES)),
  reviewerStatus: maybe(z.enum(REVIEWER_STATUSES)),
  pipelineVersion: maybe(z.string()),
  deployedCommit: maybe(z.string()),
  safetyReasons: list(z.string()),
});
export type RetryHistoryEntry = z.output<typeof retryHistoryEntrySchema>;

const retryHistorySchema = z.object({
  originalId: z.string(),
  original: retryHistoryEntrySchema.nullable(),
  retries: z.array(retryHistoryEntrySchema),
});
export type RetryHistory = z.output<typeof retryHistorySchema>;

/** One Trial as the detail sends it: images, Places candidates and its retry history. */
export const trialDetailSchema = trialSchema.extend({
  userPhoto: maybe(z.string()),
  panoramaPhoto: maybe(z.string()),
  destinationPhoto: maybe(z.string()),
  placeCandidates: list(placeCandidateSchema),
  history: maybe(retryHistorySchema),
});
export type TrialDetail = z.output<typeof trialDetailSchema>;

export const trialListResponseSchema = z.object({ data: z.array(trialSchema) });

export const trialDetailResponseSchema = z.object({ data: trialDetailSchema });

// Saving a review answers with the whole saved document, images included and
// without the fields mobile/server computes for a row, so only the review is read.
const savedReviewSchema = trialSchema.pick({
  reviewOutcome: true,
  reviewerStatus: true,
  turnCorrectness: true,
  entranceCorrectness: true,
  reviewerNotes: true,
});
export type SavedReview = z.output<typeof savedReviewSchema>;

export const savedReviewResponseSchema = z.object({ data: savedReviewSchema });
