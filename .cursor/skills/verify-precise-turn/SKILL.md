---
name: verify-precise-turn
description: >-
  Execute production precise-turn Safety Gate decision logic over an explicit
  finite input domain, including boundary cases and mutation detection. Use when
  verifying that unverified precise turns cannot be emitted, or when running
  issue #172 verification.
disable-model-invocation: false
---

# verify-precise-turn

## Invariant

Never emit unverified precise-turn instructions from the decision layer.
This checker exercises **production** `preciseTurnReasons` (and related helpers).
It does **not** prove physical sensor accuracy or real-world navigation safety.
Do not claim a formal proof from this skill.

## Prerequisites

- Node 20+
- Repo checkout with `mobile/` dependencies (`npm ci` in `mobile/` or junction)
- No production credentials

## Commands

From repository root:

```bash
npx --yes tsx .cursor/skills/verify-precise-turn/scripts/check-precise-turn.ts
```

Optional mutation self-test (restores after):

```bash
npx --yes tsx .cursor/skills/verify-precise-turn/scripts/check-precise-turn.ts --mutation
```

Write results:

```bash
npx --yes tsx .cursor/skills/verify-precise-turn/scripts/check-precise-turn.ts --out docs/engineering/verify-172-results.md
```

## Input-domain assumptions (explicit)

Documented in the checker header and echoed in results:

- Discrete enumerations over confidence, boolean evidence flags, compass levels,
  GPS accuracy buckets, distance buckets, walking evidence kinds, and sensor reason sets.
- Missing / invalid / boundary values included as named cases.
- Domain size is counted at runtime — do not trust a previously reported combination
  count without reproducing it in the results file.

## Success criteria

- Every domain case that should withhold has a non-empty reason list.
- The single “all prerequisites met” case yields an empty reason list.
- With `--mutation`, a deliberate unsafe weakening is detected, then fully restored.
- Results file records domain size, pass/fail, runtime, and “not a formal proof”.
