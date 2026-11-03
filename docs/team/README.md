# Buddy Walk team handbook

Internal docs for people working on [Buddy-Walk/buddy-walk](https://github.com/Buddy-Walk/buddy-walk).
The public product site lives in `docs/` (GitHub Pages) and is separate from this folder.

Use the words in [`CONTEXT.md`](../../CONTEXT.md): **Question**, **Verified destination**, **Last Meters**, **Trial**.
Do not say last mile, field test, assistant, or chat when you mean those.

| Read this | When |
| --- | --- |
| [Overview](overview.md) | You are new, or you need the map of the repo |
| [How we work](how-we-work.md) | Opening an issue, a branch, or a PR |
| [The app](app.md) | Changing Expo / React Native |
| [The API](api.md) | Changing `mobile/server` |
| [Last Meters](last-meters.md) | Changing the turn-to-the-door pipeline |
| [Questions](questions.md) | Changing voice/text Q&A |
| [Deploy](deploy.md) | Shipping to Render or testers |
| [Local setup](local-setup.md) | Running the app and API on your machine |
| [Watch-outs](watch-outs.md) | Things that have already bitten us |
| [Nov 2 panorama briefing](nov2-panorama-fixes.md) | Why Trials lost consistent panoramas, and the two open fixes |

Architecture decisions that already landed:

- [ADR 0001](../adr/0001-last-meters-rename-keeps-stored-and-shipped-names.md) — stored and shipped names stay `last_mile`
- [ADR 0002](../adr/0002-last-meters-steps-report-to-one-trial.md) — Last Meters steps report to one Trial
- [ADR 0003](../adr/0003-question-sources-return-evidence-and-one-reply-answers.md) — Question sources return evidence

Agent skills that load this repo: [`AGENTS.md`](../../AGENTS.md) and [`docs/agents/`](../agents/).
