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

`render.yaml` documents the Blueprint. Secrets use `sync: false`.

## Dashboards

| Page | Path |
| --- | --- |
| Trials | `/last-meters-tests?token=...` |
| Usage | `/usage?token=...` |
| Companion viewer | `docs/companion-viewer.html` (polls this API) |

The old Trials URL was `/last-mile-tests`. Update bookmarks.

## App builds

GitHub Actions (`Build and Submit iOS to TestFlight`) runs EAS production iOS `--auto-submit` on push to `main` when native app files change. API-only and test-only changes do not start a build. Manual `workflow_dispatch` still works.

Store `EXPO_TOKEN` as a repository secret. Apple submit credentials stay in Expo for `ascAppId` `6778142780`.

TestFlight uses `https://buddy-walk-api.onrender.com`. Do not ship `EXPO_PUBLIC_BYPASS_AUTH=true` in a production build unless the team has agreed.

## GitHub Pages

Workflow: `.github/workflows/deploy-pages.yml`.
Publishes `docs/` on push to `main` that touches `docs/**`, excluding `docs/agents/**` and `docs/team/**`.
The public site is a product landing page, not this handbook.
