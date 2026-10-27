import type { Application, Request, Response } from "express";

export const LAST_METERS_PATH = "/api/last-meters";

/**
 * App builds already in the store call the old path, so it stays as an alias
 * until none of them do.
 * See docs/adr/0001-last-meters-rename-keeps-stored-and-shipped-names.md.
 */
export const OLD_LAST_METERS_PATH = "/api/last-mile";

export type LastMetersPath = typeof LAST_METERS_PATH | typeof OLD_LAST_METERS_PATH;

/** Serves a Last Meters handler on both paths, telling it which one the request used. */
export function postOnLastMetersPaths(
  app: Application,
  handler: (req: Request, res: Response, requestPath: LastMetersPath) => void,
): void {
  for (const requestPath of [LAST_METERS_PATH, OLD_LAST_METERS_PATH] as const) {
    app.post(requestPath, (req, res) => handler(req, res, requestPath));
  }
}
