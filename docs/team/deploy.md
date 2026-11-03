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
2. On Render: **Manual Deploy → Deploy latest commit**.
3. Confirm `deployedCommit` on `/api/last-meters/review-status` is the merge you expect.

Auto-deploy is off. Render's GitHub app only sees Raymond's personal repos. Installing it on the Buddy-Walk organization needs an **organization owner**. Until that happens, every merge needs the manual step.

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

EAS / TestFlight is a separate decision. `EXPO_PUBLIC_API_URL` defaults to this Render host.
Do not ship `EXPO_PUBLIC_BYPASS_AUTH=true` in a production build unless the team has agreed.

## GitHub Pages

Workflow: `.github/workflows/deploy-pages.yml`.
Publishes `docs/` on push to `main` that touches `docs/**`, excluding `docs/agents/**` and `docs/team/**`.
The public site is a product landing page, not this handbook.
