# The API

Express in `mobile/server`, started by `mobile/server/index.ts` (`npm run serve` from `mobile/`).
Production image: `mobile/Dockerfile`, rootDir `mobile` on Render.

## Layering

```
routes/        HTTP paths
controllers/   request/response
services/      Question, Last Meters, maps, Doorfront, MTA, companion
utils/         pure helpers (places, policy, outdoor panorama, timing)
database/      mongoose models
config/        serverMode, lastMetersPaths
```

A new endpoint belongs in that order. Do not put pipeline logic in a route file.

## Capabilities and keys

Each capability is local only when *its own* keys exist; otherwise that one capability proxies to `UPSTREAM_API_ROOT` (default `https://buddywalk.app`). Adding `OPENAI_API_KEY` must not take Azure speech down.

| Capability | Keys | Local when |
| --- | --- | --- |
| AI (Question + Last Meters model calls) | `OPENAI_API_KEY` | key present |
| Speech | `AZURE_SUBSCRIPTION_KEY` and `AZURE_REGION` | both present |
| MTA | `MTA_API_KEY` | key present |
| Maps / Street View | `GOOGLE_MAPS_API_KEY` or `GOOGLE_API_KEY` | either present |
| Last Meters pipeline | OpenAI + Maps | both |

`GET /api/health` reports the live routing (`local` vs `proxy`) for each.
buddywalk.app's `/api/text` is retired (returns 500), so Question and Last Meters always run here when the AI keys are set.

Mongo: `MONGODB_URI` or `DATABASE_URL` or `WEB_LINK`. In development, missing URI falls back to `mongodb://127.0.0.1/vlm_dev`. If Mongo is down, the server still starts and keeps metrics, chat logs, and companion sessions in memory.

## Paths the app calls

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/last-meters` | Last Meters |
| POST | `/api/last-mile` | Alias; keep until shipped builds are gone (ADR 0001) |
| POST | `/api/text` | Question |
| POST | `/api/parseRequest` | Question routing helper |
| POST | `/api/audio` | Spoken Question |
| GET | `/api/token/getToken` | Azure speech token |
| POST | `/api/transcribe` | Speech-to-text |
| * | `/api/mta` | Arrivals |
| * | companion, telemetry, feedback, chat log | Stay on this server even in proxy mode |

## Dashboard-only paths (renamed)

These are not called by the app, so they were renamed outright (ADR 0001):

| What | Path |
| --- | --- |
| Trials | Team console, `/trials` |
| Review / deploy check | `/api/last-meters/review-status` |
| Retry a Trial | under the Last Meters test-log routes |
| Usage | Team console, `/usage` |

`/last-meters-tests`, `/last-mile-tests` and `/usage` on the API redirect to the Team console, without the token. Bookmark the new URLs.

The API paths require `ADMIN_TOKEN`. Do not print it, commit it, or paste it into a ticket. The Team console signs in through Cloudflare Access.

## Stored names that stay old

Mongo collections: `last_mile_test_log`, `last_mile_retry_run`.
Analytics: `feature: 'last_mile'`.
Step names: `proxied_last_mile`, `proxied_last_mile_text`.

Models in code are named Last Meters and pass the collection name explicitly. No migration.

## Root `server/` is not this API

`server/` at the repo root is an older Express app. Render does not build it.
It still contains a commented Atlas connection string with credentials (commit `b8870de`). Do not echo that string. An owner should rotate the cluster password if that URI was ever real, and remove the comment.
