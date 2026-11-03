# Questions

A Question is free-form voice or text, optionally with a photo or video, answered from the user's location, chat history, and outside data (trains, Doorfront, nearby features, directions).

Entry: `OpenAIQuestionService.textRequest` (`mobile/server/services/openAIQuestionService.ts`).
The pipeline returns `{ status, body }`; it does not write the HTTP response from inside a step (ADR 0003).

## Steps

1. **Read the request** — location trust, nearby-place query, attached frames, photo vs video. No outside calls (`questionRequest.ts`).
2. **Describe where the user is** — street address, compass heading, orientation (`questionLocation.ts`).
3. **Gather evidence** — one of three paths:
   - verified walking directions
   - a photo or video prompt
   - the tool the routing call picks (`questionEvidence.ts`, `questionTools.ts`)
4. **Answer** — system message, recent history, model call, Doorfront description written back (`questionAnswer.ts`).
5. **Reply** — one module owns the history entry, the AI request log row, and the `{ output, history, route }` body (`questionReply.ts`).

A step that ends early (location not trusted, destination not verified, directions answered without the model) returns that reply as a value.

Each routed tool is a function that returns evidence, behind one dispatch on the tool name.

## Known mismatch left on purpose

The two verified-directions paths do not log the same `toolUsed`:

- up-front path: `verifiedNearbyWalkingDirections`
- fallback after tool routing: `generateGoogleDirectionAPILink`, and only this path adds the Last Meters instruction for an attached photo

ADR 0003 kept that mismatch. Do not "make them match" inside a refactor.

## What was deleted because it could never run

- The older directions lookup after the fallback (it needed `verifiedNearbyAnswer` to be false when the fallback had just set it true).
- The static map URL the nearby features tool built and never used.

## Tests

Characterization through `textRequest` checks the answer, the prompt sent to the model, and the log row.
See `mobile/src/test/questionService.test.ts` and the `question*.test.ts` files beside it.

Question and Last Meters share Verified destination lookup. They share no new module.
