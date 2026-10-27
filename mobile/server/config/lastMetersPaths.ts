import type { Application, Request, Response } from "express";

/**
 * The path the app calls for Last Meters, then the old path. App builds
 * already in the store call the old one, so it stays as an alias until
 * none of them do.
 * See docs/adr/0001-last-meters-rename-keeps-stored-and-shipped-names.md.
 */
export const LAST_METERS_PATHS = ["/api/last-meters", "/api/last-mile"] as const;

export type LastMetersPath = (typeof LAST_METERS_PATHS)[number];

/** Serves a Last Meters handler on both paths, telling it which one the request used. */
export function postOnLastMetersPaths(
  app: Application,
  handler: (req: Request, res: Response, requestPath: LastMetersPath) => void,
): void {
  for (const requestPath of LAST_METERS_PATHS) {
    app.post(requestPath, (req, res) => handler(req, res, requestPath));
  }
}
