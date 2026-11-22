export const LAST_METERS_PROGRESS_CONTENT_TYPE = "application/x-ndjson";

export const LAST_METERS_MODULES = [
  "preCheck", "currentViewMatch", "destinationMatch", "turnDecision", "guidance",
] as const;

export type LastMetersModule = (typeof LAST_METERS_MODULES)[number];

export interface LastMetersProgressEvent {
  type: "module_started";
  module: LastMetersModule;
}

export type LastMetersStreamEvent = LastMetersProgressEvent | {
  type: "result";
  status: number;
  body: Record<string, unknown>;
};

export function isLastMetersModule(value: unknown): value is LastMetersModule {
  return LAST_METERS_MODULES.some(module => module === value);
}
