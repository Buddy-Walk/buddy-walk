# verify-precise-turn results (#172)

**Status:** PASS
**Runtime:** 50 ms
**Formal proof:** no — finite-domain execution of production `preciseTurnReasons` only.

## Domain

- Enumerated size (runtime): **82944**
- Cartesian expectation: **82944**
- Clear (should authorize) cases: 3
- Withhold cases: 82941

### Assumptions

- Discrete buckets listed in `DOMAIN` inside `check-precise-turn.ts`.
- Includes missing/invalid GPS accuracy, non-positive distance, and multi-reason sensor sets.
- Does not claim coverage of continuous physical sensor space.

## Mutation

- Unsafe empty-reasons mutation detected; production function still withholds after restore check.

## Failures

- none
