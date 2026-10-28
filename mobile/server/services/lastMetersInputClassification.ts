import { parseLastMetersInput } from "../../src/utils/lastMetersInput";
import type { LastMetersRequestInput } from "../utils/lastMetersReplay";
import type { LastMetersTrial, StepResult } from "./lastMetersTrial";

/**
 * Decides whether the Last Meters input names a place or asks a question.
 * Returns the place to search for, or ends the run by handing the question
 * to the Question service.
 */
export async function classifyInput(
  trial: LastMetersTrial,
  request: Pick<LastMetersRequestInput, "lat" | "lng" | "destination" | "deviceHeading" | "gpsAccuracyMeters">,
  image: string,
): Promise<StepResult<string>> {
  const { lat, lng, destination, deviceHeading, gpsAccuracyMeters } = request;
  const parsedInput = parseLastMetersInput(destination);
  if (parsedInput.kind === "question") {
    // Older app builds send questions here; answer them like the main
    // question box would instead of searching for a place named "When is...".
    trial.note({ testScenario: "question_routed" });
    trial.step({
      name: "input_classification",
      prompt:
        "Decide whether the Last Meters input names a place or asks a question.",
      response: `QUESTION (${parsedInput.reason}): sent to the question answering flow`,
      model: "deterministic-parser",
      success: true,
    });
    const asksAboutSurroundings =
      parsedInput.reason === "question" &&
      /\b(?:in front of me|around me|describe|what do you see|this)\b/i.test(
        destination,
      );
    return {
      kind: "exit",
      result: await trial.question({
        text: destination,
        image: asksAboutSurroundings && image ? [image] : undefined,
        coords: {
          latitude: lat,
          longitude: lng,
          accuracy: gpsAccuracyMeters ?? null,
          heading: deviceHeading ?? null,
        },
        analytics: {
          feature:
            parsedInput.reason === "transit"
              ? "mta"
              : asksAboutSurroundings
                ? "photo_qa"
                : undefined,
        },
      }),
    };
  }
  const destinationQuery = parsedInput.destination;
  trial.note({ destinationQuery });
  trial.step({
    name: "input_classification",
    prompt:
      "Decide whether the Last Meters input names a place or asks a question.",
    response:
      `DESTINATION: "${destinationQuery}"` +
      (parsedInput.strippedLeadIn ? " (question lead-in removed)" : ""),
    model: "deterministic-parser",
    success: true,
  });
  return { kind: "ok", value: destinationQuery };
}
