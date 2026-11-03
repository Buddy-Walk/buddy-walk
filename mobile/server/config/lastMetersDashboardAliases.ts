import type { Application, Request, Response } from "express";

/**
 * Bookmarks and shared links still hit the pre-rename dashboard paths.
 * The new paths stay the ones the dashboard itself calls.
 * See docs/adr/0001-last-meters-rename-keeps-stored-and-shipped-names.md.
 */
export function lastMetersDashboardRedirect(req: Request, toPath: string, res: Response): void {
  const search = new URL(req.originalUrl, "http://localhost").search;
  res.redirect(302, `${toPath}${search}`);
}

export function mountLastMetersDashboardAliases(app: Application): void {
  app.get("/last-mile-tests", (req, res) => {
    lastMetersDashboardRedirect(req, "/last-meters-tests", res);
  });
  app.get("/api/last-mile/review-status", (req, res) => {
    lastMetersDashboardRedirect(req, "/api/last-meters/review-status", res);
  });
}
