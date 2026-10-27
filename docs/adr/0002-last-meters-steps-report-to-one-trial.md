# Last Meters steps report to one Trial and return their exits

`runLastMeters` is split into steps that each take inputs and return a result, around a `LastMetersTrial` module that owns the Trial being recorded.
The Trial holds whole objects (the Verified destination, the panorama, the heading comparison) and builds the saved row from them in one place, so steps stop copying fields into dozens of shared variables.
A step that ends the run early returns that exit as a value, and `runLastMeters` decides what happens next, so every place a run can end is visible in `runLastMeters`.

The steps are:

- finding the Verified destination and its entrance, including the nearby-branch check
- the proximity gate (aligned, approach, or exact), with no outside calls
- panorama heading matching: the current view, the destination, the reference photo and sign text backups, and moving on to another panorama
- the turn decision: confidence, the walking route, and the guidance policy's turn checks
- composing the guidance: the turn instruction, landmarks, and the final answer

What a run answers, the prompts it sends, and the saved Trial row stay exactly the same, because the dashboard and retries read the row's field names.
Exits that had no test get characterization tests through `runLastMeters` before any code moves, checking both the answer and the full saved row.

Question and Last Meters share no new module.
They already share the Verified destination lookup, and Question's Street View and Doorfront path is separate from Last Meters panorama selection.

## Considered Options

- **Steps return their logged steps and facts along with their results, and `runLastMeters` merges them.**
  Rejected: every step's return type carries logging, and `runLastMeters` grows back into the merge code this split removes.
- **Steps throw an exit that one catch in `runLastMeters` turns into the answer.**
  Rejected: shorter, but the places a run can end would be hidden inside the steps.
- **Put OpenAI and Google behind ports with fake adapters for tests.**
  Rejected: each would have one production adapter, and tests already replace them by mocking `axios` and the OpenAI client.
