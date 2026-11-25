# Deploy buddy-walk-api verified gate — issue #137

## Behavior

Triggers are **unchanged**:

- `push` to `main` for `mobile/**`, `render.yaml`, deploy workflow, or gate scripts
- `workflow_dispatch`

Before the Render deploy hook:

1. Unit-test `.github/scripts/required-checks.mjs`
2. Wait until check runs **`backend`** and **`team-console`** on **`github.sha`** conclude `success`
3. On `push`, require that `main` tip still equals `github.sha` (tip-skew → fail closed; newer push owns deploy)
4. Curl `RENDER_DEPLOY_HOOK_URL` (still tip-of-main semantics; `?ref=` unsupported)
5. Poll `https://buddy-walk-api.onrender.com/api/health` until success or timeout (fail closed)

Concurrency group `deploy-buddy-walk-api-main` with `cancel-in-progress: true` drops stale waiters when a newer deploy run starts.

## Transition (no production gap)

This change does **not** disable the push trigger or Render auto paths. The first production push after merge still fires Deploy buddy-walk-api; it simply **delays** the hook until Backend CI + Check are green on that SHA. There is no window where pushes stop deploying without a replacement.

## `workflow_dispatch` policy

Manual runs use the same required-check wait on the selected ref’s `github.sha`. Tip-of-main enforcement is **not** applied on dispatch so an admin can intentionally redeploy a verified older revision after checks for that SHA are green. Prefer dispatch only when those checks are already green.

## Rollback

Revert the `deploy-api.yml` / `.github/scripts/*` commit on `main` (or restore the previous workflow file). Push trigger returns to immediate hook curl without waiting. No Render dashboard change required.

## Out of scope (needs separate approval)

- Live Render service settings
- Installing Render’s GitHub app
- Removing the push trigger
- Pinning Render to a non-tip SHA (API returns 500 for `?ref=`)
