# Coding standards

The judgement calls a reviewer checks a change against.
Rules a tool can check live in the linters and tests instead.

## Saved Trials stay readable

The shape of a saved Trial keeps changing, and every Trial ever saved must keep showing and counting, on the Team console and in mobile/server.
Flag a change that would hide an older Trial, fail a response because of one, or stop counting what it recorded.

- Code that reads saved Trials accepts every shape ever written.
  A field that is absent, null or in an older shape reads as missing, and the rest of the Trial still shows.
  In `team-console/src/lib/trials/schema.ts`, saved fields go through `maybe` and `list`, and only the fields mobile/server computes for each row are required.
- An older field that recorded the same fact is read with its newer meaning.
  `outcomeOf` reads `reviewerStatus` `pass`, `partial` or `fail` as the matching outcome when `reviewOutcome` is absent, and module timings keep the `step0` and `moduleB` to `moduleE` keys.
- A write keeps filling an older field while anything still reads it.
  Saving a review writes `reviewerStatus` alongside `reviewOutcome`, so pass/partial/fail filters and exports keep working.
- A Mongoose `enum` or `required` describes new writes only.
  Trials saved before it was added, and updates that skip validation, can still hold other values.
- A change to a saved Trial field comes with a test that reads a Trial saved in the old shape.
