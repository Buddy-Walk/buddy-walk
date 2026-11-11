import { timingSafeEqual } from "node:crypto";
import type { Application, Request, Response } from "express";
import * as Sentry from "@sentry/node";

/** One test event a minute, so a flag left on cannot flood the project. */
export const SENTRY_DEBUG_MIN_INTERVAL_MS = 60_000;

/** Header-only check: a token in the URL would land in request logs. */
export function hasAdminHeader(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || !expected) return false;
  const given = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** The status the debug route answers with: sent, refused, or too soon. */
export function decideDebugEvent(
  provided: unknown,
  expected: string,
  now: number,
  lastSentAt: number | undefined,
): 202 | 401 | 429 {
  if (!hasAdminHeader(provided, expected)) return 401;
  if (lastSentAt !== undefined && now - lastSentAt < SENTRY_DEBUG_MIN_INTERVAL_MS) return 429;
  return 202;
}

/**
 * Sends one test error so a deploy can prove Sentry ingest end to end.
 * Mounted only with SENTRY_DEBUG_ROUTE=1 and an ADMIN_TOKEN; callers POST with
 * the token in the x-admin-token header.
 */
export function mountSentryDebugRoute(app: Application): void {
  if (process.env.SENTRY_DEBUG_ROUTE !== "1") return;
  const expected = process.env.ADMIN_TOKEN?.trim();
  if (!expected) {
    console.warn("[sentry] SENTRY_DEBUG_ROUTE=1 ignored: set ADMIN_TOKEN so the debug route is not open.");
    return;
  }
  let lastSentAt: number | undefined;
  app.post("/api/debug-sentry", (req: Request, res: Response) => {
    const now = Date.now();
    const status = decideDebugEvent(req.headers["x-admin-token"], expected, now, lastSentAt);
    if (status === 401) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (status === 429) {
      res.status(429).json({ error: "One test event a minute" });
      return;
    }
    lastSentAt = now;
    const eventId = Sentry.captureException(new Error(`Sentry test error ${now}`), {
      tags: { subsystem: "sentry-debug" },
    });
    res.status(202).json({ ok: true, eventId });
  });
}
