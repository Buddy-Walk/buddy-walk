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

### What Sentry receives

Testers are blind and walk with the camera and GPS on, so both SDKs send errors and timings only.

| Sent | Not sent |
| --- | --- |
| Exceptions with stack traces, our `subsystem` / `feature` tags | Request or response bodies (Questions, camera frames, GPS) |
| Release, environment, device / OS / runtime context | User identity, IP address, cookies |
| Sampled timings (20% of requests in production) | Header values other than `content-type` / `content-length` |
| URL paths | Query string values |
| | OpenAI prompts and answers, Mongo query data, stack-frame variables |
| | Console output, screenshots, view hierarchy |

Only Render and release app builds send. Local runs, including the Team console stack, send nothing unless `SENTRY_DSN` (API) or `EXPO_PUBLIC_SENTRY_DSN` (app) is set.

The API sets this with `dataCollection` in `mobile/server/instrument.ts`: SDK v11 collects everything unless told otherwise.
The app sets `sendDefaultPii: false` in `mobile/src/sentry.ts`.
Session replay is off. An internal build can set `EXPO_PUBLIC_SENTRY_REPLAY=1` for masked replays on errors; never set it for TestFlight.

### Checking ingest after a deploy

With `SENTRY_DEBUG_ROUTE=1` and `ADMIN_TOKEN` set, the API sends one test error per call, at most one a minute:

```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" https://buddy-walk-api.onrender.com/api/debug-sentry
```

The route does not exist without both variables. Unset `SENTRY_DEBUG_ROUTE` again afterwards.

### Source maps

EAS builds upload source maps to Sentry when the `SENTRY_AUTH_TOKEN` EAS secret is set.
Until then `SENTRY_ALLOW_FAILURE=true` in `mobile/eas.json` lets the build finish without them, and app stack traces stay minified.

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
