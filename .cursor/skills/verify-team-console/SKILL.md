---
name: verify-team-console
description: >-
  Drive and prove Team Console journeys with isolated fixtures: startup,
  persistence, Open Trial, older Trial compatibility, outcome scoring, usage,
  screenshots/a11y evidence, and cleanup. Use for issue #171 verification.
  Never connect to production Mongo.
disable-model-invocation: false
---

# verify-team-console

## Guarantee

No production MongoDB or production API credentials. The local stack uses a
throwaway database under `team-console/.stack/` that is deleted on shutdown.

## Prerequisites

- `bun` 1.4+ (Team Console packageManager)
- `mongod` on PATH (local-stack)
- Playwright browsers: `bunx playwright install chromium`
- From `team-console/`: `bun install`

## Commands

### Full journey verification (preferred)

```bash
cd team-console
bun scripts/local-stack.ts -- bunx playwright test --reporter=line
```

Artifacts: Playwright output under `team-console/test-results/` (gitignored).
Stack cleanup: `local-stack` removes `.stack/db` on exit (success or failure).

### Skill wrapper (records results)

```bash
npx --yes tsx .cursor/skills/verify-team-console/scripts/verify-team-console.ts
```

The wrapper checks prerequisites, runs the stack+e2e command when available,
and writes `docs/engineering/verify-171-results.md`. If `mongod`/`bun` are
missing, it fails clearly and still documents what was (not) run.

### Lib-level isolation checks (no Mongo)

```bash
npx --yes tsx .cursor/skills/verify-team-console/scripts/verify-team-console.ts --lib-only
```

Exercises pure Trial filter/fixture helpers for isolation and cleanup without a browser.

## Journeys covered by Playwright e2e

See `team-console/e2e/`: trials list/detail, reviews/outcomes, retries, usage.
Skill treats those specs as the source of journey coverage.

## Success criteria

- [ ] Prerequisites documented and checked
- [ ] Isolated sample DB (no production URI)
- [ ] Trial open / older Trial / outcome / usage journeys executed (or explicitly blocked)
- [ ] Cleanup verified (`.stack/db` removed after stack exit)
- [ ] Results file written with actual command output summary
