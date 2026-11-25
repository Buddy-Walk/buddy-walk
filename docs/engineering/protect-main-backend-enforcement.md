# protect-main: require Backend CI (`backend`) — issue #136

**Status:** documentation and proposed configuration only.  
**Do not apply** the ruleset change until a maintainer with admin rights explicitly authorizes it.

Observed on `main` @ `ea0562a` (2026-11-25):

| Signal | Value |
| --- | --- |
| Ruleset | `protect-main` id `25439218` (rulesets; classic branch protection returns 404) |
| Required checks today | `team-console` only (`integration_id` 15368) |
| Required approving reviews | `0` (issue text that said “one approving review” is stale) |
| Backend CI check run name | **`backend`** (workflow title is `Backend CI`) |
| Check workflow check run name | **`team-console`** (workflow title is `Check`) |
| Pages | **excluded** — do not add any Pages check |

## Why these names

GitHub required checks match the **check run `name`**, not the workflow `name:`.

Requiring `Backend CI` or `Check` as contexts would never satisfy and would **deadlock merges**.

## Deadlock / skip / stale analysis

| Risk | Assessment |
| --- | --- |
| Path-filtered workflow never reports | Backend CI has **no** path filter on `pull_request` / `push` → always reports `backend`. |
| Conditional job inside Check | Job `team-console` always runs; heavy steps are skipped when `team-console/**` unchanged, but the job still **succeeds** and reports. |
| Stale required checks | `strict_required_status_checks_policy` is currently `false`. Leaving it false avoids forcing branch up-to-date churn; enabling strict is a separate product decision. |
| Pages failure | Pre-existing Deploy GitHub Pages failures must stay **out** of required checks so they cannot block merges. |
| Workers Builds / CodeRabbit | Advisory; not proposed as required for #136. |

## Proposed ruleset configuration

Keep every existing rule on `protect-main`. Change only `required_status_checks`:

```json
{
  "required_status_checks": {
    "strict_required_status_checks_policy": false,
    "required_status_checks": [
      { "context": "team-console", "integration_id": 15368 },
      { "context": "backend" }
    ]
  }
}
```

`team-console` remains. Add **`backend`**. Do not add Pages.

### Example admin apply (authorization required)

Inspect first:

```bash
gh api repos/Buddy-Walk/buddy-walk/rulesets/25439218
```

Then update via the rulesets API (admin). Prefer the GitHub UI “Edit ruleset → Require status checks to pass → add `backend`” if the API payload shape for partial updates is unclear. Confirm after apply that a PR shows both `team-console` and `backend` as required.

## Rollback

1. Edit `protect-main` and remove the `backend` required check.
2. Leave `team-console` in place.
3. Confirm a PR can merge with only the previous required set (still subject to other rules).

No application code rollback is involved.

## Verification after apply (maintainer)

1. Open a no-op PR → both `backend` and `team-console` appear; both required.
2. Force a failing backend test on a throwaway branch → merge blocked.
3. Confirm Pages red does not block.
4. Confirm unrelated (non-`team-console/**`) PRs still get a green `team-console` check (skipped steps, successful job).

## Relationship to #137

#136 blocks **merges** without green `backend`.  
#137 gates **Render deploy hook** until `backend` and `team-console` succeed on the candidate SHA.  
They are independently reviewable; apply order recommendation: land #137 workflow first (reversible YAML), then apply this ruleset when authorized.
