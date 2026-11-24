# #140 local verification results

**Branch:** `test/140-http-failure-coverage`  
**Worktree:** `%TEMP%\bw-worktrees\http-140`  
**Status:** Local implementation complete — WAITING_FOR_APPROVAL to commit/push/PR

## Suite

`mobile/src/test/httpFailurePaths.test.ts` registered in `runAll.test.ts`.

Command:

```text
cd mobile
npx tsx --test src/test/httpFailurePaths.test.ts
```

## Result (2026-11-23)

**8 pass / 0 fail** (serial `describe`, concurrency false).

Covered contracts:

| Case | Expected |
| --- | --- |
| Malformed Last Meters body | 400 `Missing or invalid required fields` |
| Missing image | 400 same |
| Forced local without keys (`ZERO_CONFIG=false`) | 503 mentions `OPENAI_API_KEY` |
| Proxied upstream unreachable (`127.0.0.1:9`) | 502 `Upstream API unavailable` |
| Failure isolation (bad then good) | 400 then 200 `destination_not_verified` |
| `parseRequest` empty text / non-numeric lat | stable 400s |
| Telemetry without Mongo | 200 accepted into memory |
| Telemetry malformed | 400 installId/sessionId required |

No production credentials or Mongo used (`isMongoConnected() === false`).

## AC mapping

- Critical API behaviors identified — yes (Last Meters, Question parse, telemetry).
- Meaningful HTTP integration test — yes (Express listen + fetch).
- External dependency failure — yes (upstream ECONNREFUSED → 502).
- CI-ready via `runAll` — yes (Backend CI lands with #141).
- No production credentials — yes.
