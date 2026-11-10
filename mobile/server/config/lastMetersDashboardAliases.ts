import type { Application } from "express";

const TEAM_CONSOLE_URL = "https://buddy-walk-team-console.buddywalk.workers.dev";

// The pages this server used to serve, bookmarked with ?token=... The token is
// left behind on purpose: the console signs in through Cloudflare Access.
// See docs/adr/0004-team-console-on-cloudflare-workers-behind-access.md.
const TEAM_CONSOLE_PAGES = {
  "/last-meters-tests": "/trials",
  "/last-mile-tests": "/trials",
  "/usage": "/usage",
};

export function mountLastMetersDashboardAliases(app: Application): void {
  for (const [oldPath, consolePath] of Object.entries(TEAM_CONSOLE_PAGES)) {
    app.get(oldPath, (_req, res) => {
      res.redirect(302, `${TEAM_CONSOLE_URL}${consolePath}`);
    });
  }
  // Scripts and shared links still hit the pre-rename path. See
  // docs/adr/0001-last-meters-rename-keeps-stored-and-shipped-names.md.
  app.get("/api/last-mile/review-status", (req, res) => {
    const search = new URL(req.originalUrl, "http://localhost").search;
    res.redirect(302, `/api/last-meters/review-status${search}`);
  });
}
