# Triage Labels

The skills speak in terms of five canonical triage roles.
This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Only `wontfix` exists in the GitHub repo today.
Create the other four on first use (`gh label create <name>`) rather than substituting a similar existing label such as `question`.

Edit the right-hand column to match whatever vocabulary you actually use.

## Scope labels

A scope label marks which part of the product an issue belongs to, so the team can filter by it.
An issue carries its scope label alongside its triage label.

| Label                   | Apply to                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| `live-feedback-preview` | Every issue for Live Feedback Preview, the testing-ground Last Meters app |
