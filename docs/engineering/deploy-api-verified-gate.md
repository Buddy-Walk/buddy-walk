# Deploy buddy-walk-api verified gate — issue #137

## Behavior

Triggers are **unchanged**:

- `push` to `main` for `mobile/**`, `render.yaml`, deploy workflow, or gate scripts
- `workflow_dispatch`

Jobs:

1. **`verify`** (concurrency cancel-in-progress): unit-test helpers; wait until check runs **`backend`** and **`team-console`** on **`github.sha`** conclude `success`; on `push`, require tip of `main` == `github.sha`.
2. **`deploy`** (concurrency does **not** cancel in-progress): re-assert tip on push; curl `RENDER_DEPLOY_HOOK_URL`; settle; poll `/api/health` until success or timeout.

Fail closed on tip skew, failed/missing/ambiguous required checks, missing secret, or health timeout.

## Transition (no production gap)

This change does **not** disable the push trigger or Render auto paths. The first production push after merge still fires Deploy buddy-walk-api; it simply **delays** the hook until Backend CI + Check are green on that SHA.

## `workflow_dispatch` policy

Manual dispatch still curls the **unversioned** hook, which deploys **current tip of `main`**, not an older selected ref. The wait step verifies checks for `github.sha` of the dispatch ref; if that SHA is not tip of `main`, tip skew is skipped on dispatch, but the hook will still deploy whatever is tip when Render clones. Use dispatch only when tip of `main` is the intended revision and its `backend` + `team-console` checks are green. Older-revision rollback requires a Render mechanism that can select a SHA (not available on this public-Git hook; `?ref=` returns 500) — separate authorization.

## Known residuals (need separate approval)

1. Hook cannot pin `github.sha` (`?ref=` → 500). Tip re-assert narrows but does not close TOCTOU if `main` moves in the curl window, especially for path-filter-skipped pushes.
2. `/api/health` does not return git SHA, so health proves API liveness after a settle delay, not that `github.sha` is the live revision.

## Rollback

Revert the `deploy-api.yml` / `.github/scripts/*` commit on `main`. Push trigger returns to immediate hook curl without waiting. No Render dashboard change required.

## Out of scope (needs separate approval)

- Live Render service settings / GitHub app install / SHA-targeted deploys
- Removing the push trigger
- Changing `/api/health` to expose revision identity
