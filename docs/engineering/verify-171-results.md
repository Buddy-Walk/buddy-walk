**Status:** PARTIAL — lib PASS; browser journeys BLOCKED (mongod missing)
**Runtime:** 12712 ms

# verify-team-console results (#171)

**Started:** 2026-11-23T14:19:47.959Z

## Prerequisites

- bun: yes
- mongod: NO
- team-console dir: yes

## Lib isolation

- PASS: filterTrials isolates by query; empty filters reported cleanly

## Lib unit suite (vite-plus)

- PASS:  Test Files  14 passed (14) |       Tests  169 passed (169)

## Browser journeys (local-stack + Playwright)

- ran: false
- BLOCKED: Full journeys BLOCKED on this machine: need bun + mongod. Install mongod and re-run without --lib-only.

## Production safety

- No production Mongo URI used.
