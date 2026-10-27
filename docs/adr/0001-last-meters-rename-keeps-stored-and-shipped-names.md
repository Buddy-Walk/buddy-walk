# The Last Meters rename keeps stored and shipped names

Code in `mobile/` says Last Meters, but a few names outside the code keep the old "last mile" spelling on purpose, because changing them would break shipped app builds or split existing data.

- **Mongo collections** stay `last_mile_test_log` and `last_mile_retry_run`.
  The models and types are named Last Meters, and each model passes its collection name explicitly, so no data migration is needed and existing records stay readable.
- **Stored values** stay as they are: the analytics `feature: 'last_mile'` and the test log step names `proxied_last_mile` and `proxied_last_mile_text`.
  Renaming them would split analytics history and make old and new test log records look different.
- **`POST /api/last-mile`** stays as an alias of `POST /api/last-meters`, because app builds already in the store call it.
  Each Last Meters test log record stores the `requestPath` it arrived on.
  The old path can be removed once no record with `/api/last-mile` has appeared for 30 days after the first store build that calls `/api/last-meters` shipped.

Each kept name carries a comment pointing here, so nobody "fixes" it.

## Considered Options

- **Migrate the collections and rename the stored values.**
  Rejected: the migration carries risk and the only gain is tidier names.
- **Rename `/api/last-mile` outright.**
  Rejected: it breaks shipped app builds, and nobody on the team can see which builds are still in use.
- **Watch for old-path hits in the server logs instead of storing `requestPath`.**
  Rejected: log retention is short and the logs can't be queried.

The dashboard-only paths (`/api/last-mile-tests`, `/last-mile-tests`, `/api/last-mile/review-status`) are renamed outright, because only the dashboard served by the same server calls them.
