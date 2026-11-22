# Overview

Buddy Walk helps blind and low-vision pedestrians get where they are going.
The product in testers' hands is the **Expo mobile app**. The API that app talks to is the Express server in `mobile/server`, deployed as **buddy-walk-api** on Render.

## What the user can do

- Ask a **Question** by voice or text, with an optional photo or video.
- Get **Last Meters** guidance: standing near a **Verified destination**, take a photo, and hear a turn toward the door.
- Save places, share a companion link, and hear answers spoken aloud.

A directions Question with a photo is still a Question. Last Meters is a separate pipeline with its own request, Trial, and dashboard.

## Repo layout

```
Buddy-Walk/buddy-walk
├── CONTEXT.md          Glossary for the whole product
├── AGENTS.md           How agents should work in this repo
├── docs/
│   ├── adr/            Architecture decisions (0001–0003)
│   ├── agents/         Issue tracker and triage skills
│   ├── team/           This handbook (not published to Pages)
│   ├── index.html      Public product site
│   └── companion-viewer.html
├── mobile/             What we ship
│   ├── src/            Expo 57 / React Native 0.86 / React 19 app
│   ├── server/         Express API (Questions, Last Meters, admin endpoints)
│   ├── Dockerfile      What Render builds
│   └── docs/           Last Meters notes used while reviewing Trials
├── src/                Legacy Vite + React + MUI PWA (not deployed)
├── server/             Legacy Express (not deployed; diverged from mobile/server)
└── render.yaml         Blueprint for buddy-walk-api (rootDir: mobile)
```

`render.yaml` deploys `mobile/`, not the root Dockerfile. The GitHub Pages workflow publishes `docs/` except `docs/agents` and `docs/team`.

## Who writes what

Work lands through GitHub issues and pull requests on `Buddy-Walk/buddy-walk`.
Do not push to `main`. Do not treat someone else's PR as a request surface.

## What is live today

| Thing | Where |
| --- | --- |
| API | https://buddy-walk-api.onrender.com |
| Health | `GET /api/health` |
| Deploy check | `GET /api/last-meters/review-status` |
| Trials | https://buddy-walk-team-console.buddywalk.workers.dev/trials |
| Usage | https://buddy-walk-team-console.buddywalk.workers.dev/usage |
| Product site | GitHub Pages from `docs/` |

As of 2 November 2026 the Render service builds from this org repo's `main`. A merge to `main` that touches `mobile/` deploys through GitHub Actions. Confirm `deployedCommit` on `/api/last-meters/review-status`.

The two panorama fixes ([PR #43](https://github.com/Buddy-Walk/buddy-walk/pull/43), [PR #45](https://github.com/Buddy-Walk/buddy-walk/pull/45)) are not on `main` yet. Merging them is what ships them to testers.
