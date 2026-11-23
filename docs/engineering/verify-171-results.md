**Status:** PASS (lib-only)
**Runtime:** 187060 ms

# verify-team-console results (#171)

**Started:** 2026-11-23T21:26:22.326Z

## Prerequisites

- bun: yes
- mongod: NO
- mongoimport: NO
- mobile/node_modules/.bin/tsx: NO (run npm ci in mobile/)
- team-console dir: yes

## Lib isolation

- PASS: filterTrials isolates by query; empty filters reported cleanly

## Lib unit suite (vite-plus)

- PASS:  Test Files  14 passed (14) |       Tests  169 passed (169)

## Browser journeys (Playwright webServer + local-stack)

- ran: false
- BLOCKED: skipped

- Cleanup: this wrapper never deletes `.stack/db`. Playwright/`local-stack` remove only the DB they create.

## Production safety

- No production Mongo URI used.
