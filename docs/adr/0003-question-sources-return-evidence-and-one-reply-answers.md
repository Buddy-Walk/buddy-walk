# Question data sources return evidence, and one reply answers

`OpenAIQuestionService.textRequest` is split into steps that take inputs and return values, so its shared variables (`systemContent`, `completeAIPrompt`, `relevantData`, `panoramaId`, `userContent`, `toolUsed`, `structuredRoute`) go away.
Each data source returns one evidence value: what it adds to the prompt and to the relevant data, the history `data` it leaves, any images for the model, the Doorfront panorama to describe, the walking route, and the `toolUsed` it logs.
One reply module owns everything a Question sends back: the history entry, the AI request log row, and the `{ output, history, route }` body.
Every place a Question can end goes through it.

The steps are:

- reading the request: whether the location can be trusted, the nearby-place query, the attached frames, and whether it is a photo or video Question, with no outside calls
- describing where the user is: the street address, compass heading, and orientation
- gathering evidence from one of three paths: verified walking directions, a photo or video prompt, or the tool the routing call picks
- answering with the model: the system message, the recent history, the final call, and the Doorfront description written back

A step that ends the Question early (the location is not trusted, the destination is not verified, or the directions are answered without the model) returns that reply as a value, and `textRequest` sends it.
Each routed tool is its own function returning evidence, behind one dispatch on the tool name, so a tool can be read and tested without the others.

The pipeline returns the answer as `{ status, body }` instead of writing to the response, the same way `runLastMeters` does.
`textRequest` only sends what it returns, so `lastMetersRequest` keeps handing Questions to it unchanged.
The pipeline also stops writing a `0,0` location into the request it is given.

What a Question answers, the prompts and images it sends, and the AI request log rows stay exactly the same.
That includes one known mismatch between the two verified-directions paths: the up-front path logs `toolUsed: "verifiedNearbyWalkingDirections"`, while the fallback after tool routing logs `"generateGoogleDirectionAPILink"` and is the only one that adds the Last Meters instruction for an attached photo.
Which of the two is right is decided separately.
Paths that had no test get characterization tests through `textRequest` before any code moves, checking the answer, the prompt sent to the model, and the log row.

Code that can never run is deleted, because removing it changes nothing a Question does:

- the older directions lookup after the fallback, which needs `verifiedNearbyAnswer` to be false when the fallback has always just set it to true or returned
- the static map URL the nearby features tool builds and never uses

Question and Last Meters share no new module, as in ADR 0002.

## Considered Options

- **Keep one mutable request context that each tool appends to.**
  Rejected: it moves the shared variables into an object without making any step readable or testable on its own.
- **A class per tool behind a common tool interface.**
  Rejected: each tool would have one adapter and the dispatch already varies by name, so plain functions returning evidence are enough.
- **Keep writing to the response from inside the steps.**
  Rejected: every test would need a fake response, and the exits would stay hidden inside the steps.
- **Make the two verified-directions paths match while restructuring.**
  Rejected: it changes a prompt and a log value, which this refactor promises not to do.
