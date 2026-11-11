# Deploy

## Production API

| | |
| --- | --- |
| Service | `buddy-walk-api` on Render (Oregon, free, Docker) |
| Public URL | https://buddy-walk-api.onrender.com |
| Source | `https://github.com/Buddy-Walk/buddy-walk`, branch `main`, runtime Docker, rootDir `mobile` |
| Health | `GET /api/health` |
| Deploy check | `GET /api/last-meters/review-status` → `{ version, deployedCommit, enabled }` |

Until 2 November 2026 this service built from `Justraymond99/buddy_walk` (stuck at `1197391`, 17 October).
It now builds this org repo. Testers' app builds keep working: `POST /api/last-mile` is still an alias.

## How a change reaches testers

1. Merge the PR to `main`.
2. GitHub Actions (`Deploy buddy-walk-api`) hits the Render deploy hook. No dashboard click.
3. Confirm `deployedCommit` on `/api/last-meters/review-status` is the merge you expect.

Render's own Auto-Deploy does not fire (the GitHub app is not on the Buddy-Walk org). The workflow is the auto-deploy.

Do not re-sync the Blueprint on the old personal repo. That would point the service back.

## Environment on Render

Set in the dashboard, not in git:

- `OPENAI_API_KEY`
- `GOOGLE_MAPS_API_KEY`
- `AZURE_SUBSCRIPTION_KEY` / `AZURE_REGION`
- `MTA_API_KEY` (optional)
- `ADMIN_TOKEN` (Render can generate this)
- Mongo URI (`MONGODB_URI` / `DATABASE_URL` / `WEB_LINK`)
- `ALLOWED_ORIGINS`
- `SENTRY_DSN` (API project `buddy-walk-api`; optional — code has a default DSN)
- `SENTRY_ENVIRONMENT` (use `production` on Render)
- `SENTRY_RELEASE` (optional; falls back to `RENDER_GIT_COMMIT`)

`render.yaml` documents the Blueprint. Secrets use `sync: false`.

## Observability (Sentry)

Org: [buddy-walk-cuny](https://buddy-walk-cuny.sentry.io/) (US region).

| Surface | Project | SDK |
| --- | --- | --- |
| Expo app | `buddy-walk-mobile` | `@sentry/react-native` |
| Express API (`mobile/server`) | `buddy-walk-api` | `@sentry/node` |
| Team console (Cloudflare) | `buddy-walk-web` | Project created; SDK wiring follows in a bun-lockfile PR |

Uptime: [Buddy Walk API health](https://buddy-walk-cuny.sentry.io/monitors/10925083/) hits `GET /api/health` every 5 minutes.

For TestFlight / EAS, set `EXPO_PUBLIC_SENTRY_DSN` (or rely on the baked default) and optionally `EXPO_PUBLIC_SENTRY_ENVIRONMENT=production`. Do not enable `SENTRY_DEBUG_ROUTE` in production except briefly to verify ingest.

## Dashboards

| Page | Path |
| --- | --- |
| Trials | https://buddy-walk-team-console.buddywalk.workers.dev/trials |
| Usage | https://buddy-walk-team-console.buddywalk.workers.dev/usage |
| Companion viewer | `docs/companion-viewer.html` (polls this API) |

The old URLs on the API (`/last-meters-tests`, `/last-mile-tests`, `/usage`) redirect to the Team console, without the token. Update bookmarks.

## App builds

EAS / TestFlight is a separate decision. `EXPO_PUBLIC_API_URL` defaults to this Render host.
Do not ship `EXPO_PUBLIC_BYPASS_AUTH=true` in a production build unless the team has agreed.

## GitHub Pages

Workflow: `.github/workflows/deploy-pages.yml`.
Publishes `docs/` on push to `main` that touches `docs/**`, excluding `docs/agents/**` and `docs/team/**`.
The public site is a product landing page, not this handbook.
