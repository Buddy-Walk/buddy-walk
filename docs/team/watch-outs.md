# Watch-outs

Things that have already cost us time. Read once; keep them.

## Production is this org repo, deployed by hand

Render `buddy-walk-api` tracks `Buddy-Walk/buddy-walk` `main`.
It does **not** auto-deploy. After merge: Manual Deploy → Deploy latest commit.
Confirm `deployedCommit` on `/api/last-meters/review-status`.

The personal repo `Justraymond99/buddy_walk` is retired for production. Pushing there, or re-syncing its Blueprint, points testers at stale code.

## Dashboard URL changed

Trials: `/last-meters-tests`, not `/last-mile-tests`.
Deploy check: `/api/last-meters/review-status`.
`POST /api/last-mile` still works for the app.

## Stored names stay `last_mile`

Collections, analytics feature, and a few step names. See ADR 0001. Comments in code point there on purpose.

## Preserve Mykael and Hanyuan

`git blame -w -M -C -C` before deleting a line.
Do not edit their tests. Do not touch `lastMetersExits.test.ts.snapshot` to squeeze a fix through.

## Street View stays

This org repo restored Street View (`97b8cce`). CONTEXT.md and the ADRs assume it.
An earlier removal on the personal repo does not apply here.

## Last Meters vs Question

A photo plus "how do I get to X" can be a Question. Last Meters is the dedicated near-door pipeline.
Do not merge the two services. They share Verified destination lookup only.

## Characterization tests are the contract

Exits, prompts, and saved Trial rows are pinned. A refactor that changes an answer or a log field is a product change, not a tidy-up. Put it in its own issue.

## Secrets

- Never paste `ADMIN_TOKEN` into chat, issues, or docs.
- Root `server/database/index.ts` has a commented Mongo URI with credentials. Do not copy it. Rotate if that cluster is still live.
- Client `EXPO_PUBLIC_*` values are inside the binary. Treat them as public.

## Bypass auth

`EXPO_PUBLIC_BYPASS_AUTH=true` is in `.env.example` for local demos. It is a production footgun.

## Dead or misleading code

- Root `src/` — legacy web PWA, not deployed.
- Root `server/` — legacy API, not deployed.
- `mobile/src/pages/` — unused.
- `useTurnByTurnNavigation` — not the Last Meters path.
- `mobile/README.md` — old Expo version and old backend link.

## Open panorama work (2 November 2026)

Until [PR #43](https://github.com/Buddy-Walk/buddy-walk/pull/43) and [PR #45](https://github.com/Buddy-Walk/buddy-walk/pull/45) merge and Render is manually deployed, production still:

- treats two Google listings at one address as two buildings (`destination_branch_ambiguous` with the same address twice)
- jumps 30 m away when the nearest panorama is a contributor photosphere

See [nov2-panorama-fixes.md](nov2-panorama-fixes.md).
