// Test helper: Trials built the way the console receives them, through the schema.
import type { z } from "zod";

import { trialDetailSchema, trialSchema } from "./schema";

type TrialInput = Partial<z.input<typeof trialSchema>>;

const required = {
  _id: "6720f1c2a1b2c3d4e5f60718",
  hasUserPhoto: false,
  hasPanorama: false,
  hasDestinationPhoto: false,
  replay: { status: "replayable", defaultsApplied: [], originalPanorama: { available: false } },
};

export const trialFrom = (fields: TrialInput = {}) => trialSchema.parse({ ...required, ...fields });

export const trialDetailFrom = (fields: Partial<z.input<typeof trialDetailSchema>> = {}) =>
  trialDetailSchema.parse({ ...required, ...fields });
