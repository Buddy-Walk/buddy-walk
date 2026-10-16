# Review panoramas for blocked mobile captures

The Expo application and `mobile/server` deploy separately. Shipping an iOS build does not deploy the API's Street View handling. A trial that stops at `turn_safety_gate` in a few milliseconds has not reached the normal panorama search.

`MobileLastMileService` wraps the shared pipeline only for the mobile controller's instance. When a new destination capture is rejected by the initial sensor gate, it returns the original safety answer, then downloads validated outdoor imagery at the original capture coordinates and attaches it to the same trial. The saved image is marked `panoramaSource: "background"` by the existing review saver. It does not authorize a turn, replace sensor readings, or mark the failed trial successful.

Provider failures retain the panorama error code and validation attempts. Missing imagery, indoor/uncertain scenes, quota failures, and timeouts remain failures instead of becoming an invented image or instruction. Existing pipeline-owned review work is left alone.

Mykael's shared pipeline, retry handlers, retry options, original-panorama selection, and retry tests are unchanged. The adapter does not add review jobs to retries or to ordinary questions. Historical trials are not backfilled; verify the deployment with a new mobile capture.

Check the running API before retesting:

```sh
curl https://buddy-walk-api.onrender.com/api/last-mile/review-status
```

The response reports the adapter `version`, the server's `deployedCommit`, and whether its OpenAI/Maps configuration enables local Last Meters. Version `1.0.0` identifies this recovery path. A missing endpoint means that deployment does not contain the adapter.

After a blocked capture, allow the bounded background search to finish and reopen or refresh its trial details. The existing dashboard reads saved Street View images when opening the full-image detail view. The phone can continue to use build 29; this fix needs an API deployment rather than another iOS build.

Validation from `mobile/`:

```sh
npm run typecheck
npm run typecheck:server
node --import tsx src/test/runAll.test.ts
```

The regression suite covers missing capture metadata, the movement/rotation/GPS combination, missing and indoor imagery, response-before-download timing, unchanged snapshots and withheld turns, background storage failures, and isolation from retry execution. Provider calls are replaced with fixtures in tests.
