# Main-green exact-SHA verification (#190)

## Purpose

Confirm that required protect-main checks — **`backend`** and **`team-console`** — succeeded on an **exact commit SHA**. GitHub Pages and other checks are ignored.

Shares evaluation logic with the Deploy buddy-walk-api gate (#137): `.github/scripts/required-checks.mjs`.

## CLI

```bash
export GITHUB_TOKEN="$(gh auth token)"   # or a PAT with checks:read
export GITHUB_REPOSITORY=Buddy-Walk/buddy-walk
node .github/scripts/main-green.mjs --sha <full_or_prefix_sha>
```

Exit codes: `0` pass, `1` failed/ambiguous required check, `2` missing config / API / timeout.

## Actions

Actions → **Main green** → Run workflow → paste SHA.

## Agent usage

After merges, verify the **merge commit SHA** (not only the PR head) with main-green before claiming main is healthy.
