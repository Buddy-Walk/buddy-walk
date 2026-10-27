import mongoose, { Schema } from "mongoose";
import { LAST_METERS_TEST_SCENARIOS } from "../../utils/lastMetersNavigation";
import type { LastMetersTestScenario } from "../../utils/lastMetersNavigation";
import type { PlaceCandidateLog } from "../../utils/nearbyPlaces";
import type { PanoramaAttempt } from "../../services/outdoorPanoramaSelection";
import type { ReplayInput } from "../../utils/lastMetersReplay";
import type { WalkingEvidence } from "../../utils/lastMetersPolicy";

export const REVIEW_OUTCOMES = ["got_there", "needed_retake", "would_not_get_there"] as const;
export const TURN_CORRECTNESS = ["correct", "wrong", "no_turn_given"] as const;
export const ENTRANCE_CORRECTNESS = ["correct", "wrong", "not_identified"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
export type TurnCorrectness = (typeof TURN_CORRECTNESS)[number];
export type EntranceCorrectness = (typeof ENTRANCE_CORRECTNESS)[number];
export const RETRY_PANORAMA_MODES = ["fresh", "original"] as const;
export type RetryPanoramaMode = (typeof RETRY_PANORAMA_MODES)[number];

export interface lastMetersTestStepInterface {
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
}

export interface lastMetersTestLogInterface {
  /** Bumped by hand whenever a change could alter results. */
  pipelineVersion?: string;
  deployedCommit?: string;
  /** "replay" for dashboard retries, which are not field tests. */
  runKind?: "field" | "replay";
  /** Set on dashboard retries: the original field test this re-ran. */
  retryOf?: string;
  retryPanoramaMode?: RetryPanoramaMode;
  /** Values the replay compatibility check filled in for this retry. */
  retryDefaultsApplied?: string[];
  /** Versioned snapshot of exactly what the pipeline received. */
  replayInput?: ReplayInput;
  safetyReasons?: string[];
  walkingEvidence?: WalkingEvidence;
  panoramaTargetHeading?: number;
  confidenceMethod?: "heuristic-not-calibrated";
  destination: string;
  /** Place name actually searched after question lead-ins were removed. */
  destinationQuery?: string;
  lat: number;
  lng: number;
  /** Absent on dashboard retries, which reuse the original's photo. */
  userPhoto?: string;
  panoramaPhoto?: string;
  panoramaDate?: string;
  panoramaStatus?: string;
  panoramaValidation?: PanoramaAttempt[];
  /** "pipeline" when matched, "background" when saved only for review. */
  panoramaSource?: "pipeline" | "background";
  panoId?: string;
  panoramaCopyright?: string;
  panoramaAgeYears?: number;
  panoramaHeadings: number[];
  placeCandidates?: PlaceCandidateLog[];
  placesSearches?: string[];
  gpsAllowanceMeters?: number;
  exactGateWidened?: boolean;
  entranceSource?: "places_pin" | "geocoding_entrance";
  entranceLat?: number;
  entranceLng?: number;
  besideBuilding?: boolean;
  destinationOpenNow?: boolean;
  destinationBusinessStatus?: string;
  signText?: string;
  signTextMatched?: boolean;
  dataSources?: string[];
  destinationPhoto?: string;
  destinationPhotoDate?: string;
  destinationPhotoStatus?: string;
  destinationPlaceName?: string;
  destinationPlaceAddress?: string;
  destinationTypes?: string[];
  destinationDistanceMeters?: number;
  gpsAccuracyMeters?: number;
  compassAccuracyLevel?: number;
  destinationBearing?: number;
  deviceHeading?: number;
  headingDifferenceDegrees?: number;
  headingAligned?: boolean;
  compassHeading?: number;
  panoramaMatchedHeading?: number;
  headingComparisonDifference?: number;
  headingComparisonAgrees?: boolean;
  confidenceScore?: number;
  confidenceLevel?: "high" | "medium" | "low";
  confidenceReasons?: string[];
  destinationReferenceUsed?: boolean;
  navigationMode?: "approach" | "exact" | "aligned";
  testScenario?: LastMetersTestScenario;
  currentHeading?: number;
  targetHeading?: number;
  turnInstruction?: string;
  finalOutput?: string;
  steps: lastMetersTestStepInterface[];
  reviewerStatus?: "untested" | "pass" | "partial" | "fail";
  reviewerNotes?: string;
  reviewOutcome?: ReviewOutcome;
  turnCorrectness?: TurnCorrectness;
  entranceCorrectness?: EntranceCorrectness;
  reviewedAt?: Date;
  success: boolean;
  error?: string;
  latencyMs: number;
  serverTs: Date;
}

const LastMetersTestStepSchema = new Schema<lastMetersTestStepInterface>(
  {
    name: { type: String, required: true },
    prompt: { type: String, required: true },
    response: { type: String },
    parsedHeading: { type: Number },
    model: { type: String, required: true },
    success: { type: Boolean, required: true },
    error: { type: String },
    tokenCount: { type: Number },
    durationMs: { type: Number },
    panoId: { type: String },
  },
  { _id: false }
);

const PlaceCandidateSchema = new Schema<PlaceCandidateLog>(
  {
    placeId: { type: String },
    name: { type: String, required: true },
    address: { type: String },
    distanceMeters: { type: Number, required: true },
    types: [{ type: String }],
    relevant: { type: Boolean, required: true },
    source: { type: String },
    businessStatus: { type: String },
  },
  { _id: false }
);

const LastMetersTestLogSchema = new Schema<lastMetersTestLogInterface>({
  destination: { type: String, required: true, index: true },
  destinationQuery: { type: String },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  userPhoto: { type: String },
  panoramaPhoto: { type: String },
  panoramaDate: { type: String },
  pipelineVersion: String,
  deployedCommit: String,
  runKind: { type: String, enum: ["field", "replay"] },
  retryOf: String,
  retryPanoramaMode: { type: String, enum: [...RETRY_PANORAMA_MODES] },
  retryDefaultsApplied: [{ type: String }],
  replayInput: Schema.Types.Mixed,
  safetyReasons: [String],
  walkingEvidence: Schema.Types.Mixed,
  panoramaTargetHeading: Number,
  confidenceMethod: String,
  panoramaStatus: { type: String },
  panoramaValidation: [{ _id: false, panoId: String, status: String, reason: String, distanceMeters: Number }],
  panoramaSource: { type: String, enum: ["pipeline", "background"] },
  panoId: { type: String },
  panoramaCopyright: { type: String },
  panoramaAgeYears: { type: Number },
  panoramaHeadings: [{ type: Number }],
  placeCandidates: [PlaceCandidateSchema],
  placesSearches: [{ type: String }],
  gpsAllowanceMeters: { type: Number },
  exactGateWidened: { type: Boolean },
  entranceSource: { type: String, enum: ["places_pin", "geocoding_entrance"] },
  entranceLat: { type: Number },
  entranceLng: { type: Number },
  besideBuilding: { type: Boolean },
  destinationOpenNow: { type: Boolean },
  destinationBusinessStatus: { type: String },
  signText: { type: String },
  signTextMatched: { type: Boolean },
  dataSources: [{ type: String }],
  destinationPhoto: { type: String },
  destinationPhotoDate: { type: String },
  destinationPhotoStatus: { type: String },
  destinationPlaceName: { type: String },
  destinationPlaceAddress: { type: String },
  destinationTypes: [{ type: String }],
  destinationDistanceMeters: { type: Number },
  gpsAccuracyMeters: { type: Number },
  compassAccuracyLevel: { type: Number },
  destinationBearing: { type: Number },
  deviceHeading: { type: Number },
  headingDifferenceDegrees: { type: Number },
  headingAligned: { type: Boolean },
  compassHeading: { type: Number },
  panoramaMatchedHeading: { type: Number },
  headingComparisonDifference: { type: Number },
  headingComparisonAgrees: { type: Boolean },
  confidenceScore: { type: Number },
  confidenceLevel: { type: String, enum: ["high", "medium", "low"] },
  confidenceReasons: [{ type: String }],
  destinationReferenceUsed: { type: Boolean, default: false },
  navigationMode: { type: String, enum: ["approach", "exact", "aligned"] },
  testScenario: {
    type: String,
    enum: [...LAST_METERS_TEST_SCENARIOS],
    index: true,
  },
  currentHeading: { type: Number },
  targetHeading: { type: Number },
  turnInstruction: { type: String },
  finalOutput: { type: String },
  steps: [LastMetersTestStepSchema],
  reviewerStatus: {
    type: String,
    enum: ["untested", "pass", "partial", "fail"],
    default: "untested",
    index: true,
  },
  reviewerNotes: { type: String },
  reviewOutcome: { type: String, enum: [...REVIEW_OUTCOMES], index: true },
  turnCorrectness: { type: String, enum: [...TURN_CORRECTNESS] },
  entranceCorrectness: { type: String, enum: [...ENTRANCE_CORRECTNESS] },
  reviewedAt: { type: Date },
  success: { type: Boolean, required: true, index: true },
  error: { type: String },
  latencyMs: { type: Number, required: true },
  serverTs: { type: Date, default: Date.now, index: true },
});

export default mongoose.model<lastMetersTestLogInterface>(
  "LastMetersTestLog",
  LastMetersTestLogSchema,
  // Keeps its old collection name so existing records stay readable.
  // See docs/adr/0001-last-meters-rename-keeps-stored-and-shipped-names.md.
  "last_mile_test_log"
);
