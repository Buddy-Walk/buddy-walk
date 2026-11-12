# How we work

## Vocabulary

From [`CONTEXT.md`](../../CONTEXT.md):

| Say | Do not say |
| --- | --- |
| Question | assistant, chat, text request |
| Verified destination | destination lookup result, place match |
| Last Meters | last mile |
| Trial | test log record, last mile test |
| Field test (a Trial run on a real street, not a retry) | street test, live test |

Issue titles, PR titles, comments, and test names use those words.

## Issue, then branch, then PR

1. Open a GitHub issue that states the problem in product language.
2. Branch from current `main` with a prefix: `feat/`, `fix/`, `docs/`, `refactor/`, `test/`.
3. Keep the diff to that issue. Do not mix a rename, a refactor, and a behavior change.
4. Open a PR against `main`. Do not push to `main`.

Issues live in this repo. Use `gh issue create`, `gh issue view`, `gh pr create`.
External PRs are not a triage surface (`docs/agents/issue-tracker.md`).

Labels the skills expect: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
Only `wontfix` existed when this was written; create the others on first use rather than substituting `question`.

## Commits

- Imperative subject, no trailing period: `Treat listings at one address as one building`
- Author as yourself. Do not add an AI co-author trailer.
- One concern per commit when you can.

## Tests before moving code

Last Meters and Questions were split into steps *after* characterization tests pinned every exit (PRs #23 and #35).
If you change a pipeline:

- Run the existing tests in `mobile/`: `npm test` (from `mobile/`, after `npm ci`).
- Do not edit `lastMetersExits.test.ts.snapshot` unless you have regenerated it on purpose and can explain every changed exit.
- Tests mock `axios` and the OpenAI client. Do not introduce ports/adapters for those (ADR 0002).

## What not to do

- Do not wire a local Last Meters retry into production Mongo.
- Do not write to production Mongo from a laptop. Dashboard data is read-only GETs.
- Do not print, commit, or paste the admin token.
- Do not "fix" stored names `last_mile_test_log`, `last_mile_retry_run`, `feature: 'last_mile'`, or `POST /api/last-mile` (ADR 0001).
- Do not remove Street View from this repo. The org main restored it; CONTEXT.md and the ADRs assume it.
- Do not push to `Justraymond99/buddy_walk` or re-sync its Render Blueprint. That would point production back at the old repo.
