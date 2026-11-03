# Why Trials stopped getting consistent panoramas

From mid-October, Last Meters Trials either had no panorama at all or got one from a camera well away from where the user stood.
This note records what the production Trials showed, the two fixes, and how to check them once deployed.
Terms follow `CONTEXT.md`.

## What the Trials showed

The dashboard's Trials from the app between Oct 17 and Nov 1, 2026, all on deployed commit `1197391`, read without changing anything:

- 33 Trials: 21 have a panorama and 12 do not.
- Of the 12 without one, 8 ended with `destination_branch_ambiguous` before their panorama search started, and 4 ended with `destination_not_verified`.
- Of 25 panorama searches, 16 accepted a Google camera 4 to 12 meters from the user.
  The other 9 began with a contributor photosphere at the user's position and accepted a camera 16 to 34 meters away.
- No Trial failed on the outdoor visual check or on downloading the 16 views, so neither was changed.

Before Oct 11, every Trial that passed the proximity gate had a panorama.
The causes arrived within three days:

| Date | Commit | Change |
| --- | --- | --- |
| Oct 8 | `45a9bc0` | Panoramas must be captured by Google, so contributor photospheres are rejected. |
| Oct 11 | `97b8cce` | When the panorama nearest the user is rejected, the search looks 30 meters away. |
| Oct 11 | `816ddd0` | Another listing about as close as the destination withholds the turn as an ambiguous branch. |

## Fix 1: listings at one address are one building

[Issue #42](https://github.com/Buddy-Walk/buddy-walk/issues/42), [PR #43](https://github.com/Buddy-Walk/buddy-walk/pull/43).

Google lists one store more than once at one address: "Bluemercury" and "Natura Bissé x Bluemercury New York" at 275 Greenwich St, or "Target", "Target Grocery" and "Target Mobile" at 255 Greenwich St.
`verifyDestination` counted the second listing as another branch.
Every Bluemercury and Target Trial answered "Please specify the street address: 275 Greenwich St, New York or 275 Greenwich St, New York." and never started its panorama search.

`candidatesAtOtherAddresses` (`mobile/server/utils/nearbyPlaces.ts`) now leaves out candidates at the Verified destination's own street address before the ambiguity check.
A branch at a different street address within the allowance still withholds the turn and names that address.

## Fix 2: look beside the user when a photosphere is nearest

[Issue #44](https://github.com/Buddy-Walk/buddy-walk/issues/44), [PR #45](https://github.com/Buddy-Walk/buddy-walk/pull/45).

Street View metadata returns only the single panorama nearest a point.
When that was a contributor photosphere, `selectOutdoorPanorama` went straight to points 30 meters north, east, south and west of the user and took the first Google camera found there.
Three TD Bank Trials a minute apart got cameras 5, 6 and 28 meters away.

After a photosphere at the user's position, the search now looks 10 meters around the user before 30 meters away.
No imagery within 40 meters, moving on after `destination_not_visible`, and every check a camera must pass work as before.

## Whose code changed

Both fixes edit only lines Raymond wrote (in `816ddd0` and `97b8cce`) and add the rest.
No line Mykael or Hanyuan wrote is edited, and their tests and the `lastMetersExits.test.ts.snapshot` characterization snapshot are unchanged.
This was checked with `git blame -w -M -C -C` on every removed line.

## Deploying

Until Nov 2, 2026, the `buddy-walk-api` Render service built from `Justraymond99/buddy_walk`, whose main stopped at `1197391` on Oct 17, so nothing merged into `Buddy-Walk/buddy-walk` reached the app.
On Nov 2 the service was switched to build `mobile/` from `Buddy-Walk/buddy-walk` main, connected as a public Git repository.

Render auto-deploys only repositories connected through its GitHub app, and installing that app on the Buddy-Walk organization needs an organization owner.
Until an owner does, deploy each merge with **Manual Deploy → Deploy latest commit** on the `buddy-walk-api` service.

App builds already in testers' hands keep working: `POST /api/last-mile` stays as an alias of `POST /api/last-meters` (ADR 0001), and no other route the app calls changed.
The dashboard-only paths were renamed outright (ADR 0001):

- Trials dashboard: `/last-meters-tests?token=...`, formerly `/last-mile-tests`.
- Deploy check: `/api/last-meters/review-status`, formerly `/api/last-mile/review-status`.

## Checking the fixes after a deploy

1. Open `https://buddy-walk-api.onrender.com/api/last-meters/review-status` and confirm `deployedCommit` is the merged main.
2. Ask for Bluemercury or Target from near 275 or 255 Greenwich St: the Trial should reach the proximity gate and show a panorama.
3. In a Trial's "Outdoor panorama validation", a `metadata_rejected` photosphere should be followed by an `accepted` camera within about 15 meters, not 30.
