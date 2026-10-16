import assert from "node:assert/strict";
import test from "node:test";
import { parseLastMetersInput } from "../utils/lastMetersInput";

/**
 * Extract only destination parses so the destination-phrase cases fail clearly if an input is
 * routed as a question.
 */
function destinationOf(input: string): string | null {
  const parsed = parseLastMetersInput(input);
  return parsed.kind === "destination" ? parsed.destination : null;
}

test("parseLastMetersInput strips question lead-ins from field-test inputs", () => {
  // Regression test: parseLastMetersInput strips question lead-ins from field-test inputs.
  assert.equal(destinationOf("Where is bmcc"), "bmcc");
  assert.equal(destinationOf("Where is sweet green"), "sweet green");
  assert.equal(destinationOf("Where is Citibank?"), "Citibank");
  assert.equal(destinationOf("Where is the nearest Dunkin' Donuts?"), "nearest Dunkin' Donuts");
  assert.equal(destinationOf("Take me to the entrance of Fiterman Hall"), "Fiterman Hall");
  assert.equal(destinationOf("How do I get to Target"), "Target");
  assert.equal(destinationOf("Find me a pharmacy"), "pharmacy");
  assert.equal(destinationOf("Can you take me to Whole Foods please"), "Whole Foods");
});

test("parseLastMetersInput keeps bare destinations unchanged", () => {
  // Regression test: parseLastMetersInput keeps bare destinations unchanged.
  const parsed = parseLastMetersInput("Fitter man hall");
  assert.deepEqual(parsed, {
    kind: "destination",
    destination: "Fitter man hall",
    strippedLeadIn: false,
  });
  assert.equal(destinationOf("Nearest Citi Bank"), "Nearest Citi Bank");
  assert.equal(destinationOf("Chambers St subway entrance"), "Chambers St subway entrance");
  assert.equal(destinationOf("Where is the 2 train station"), "2 train station");
});

test("parseLastMetersInput routes transit questions to the answer flow", () => {
  // Regression test: parseLastMetersInput routes transit questions to the answer flow.
  assert.deepEqual(parseLastMetersInput("When is 2 train"), { kind: "question", reason: "transit" });
  assert.deepEqual(parseLastMetersInput("When is the next A train?"), {
    kind: "question",
    reason: "transit",
  });
  assert.deepEqual(parseLastMetersInput("Where is the 2 train"), {
    kind: "question",
    reason: "transit",
  });
});

test("parseLastMetersInput routes general questions to the answer flow", () => {
  // Regression test: parseLastMetersInput routes general questions to the answer flow.
  for (const input of ["Describe the video", "What is in front of me?", "Is the UPS Store open?", "help"]) {
    assert.deepEqual(parseLastMetersInput(input), { kind: "question", reason: "question" }, input);
  }
});
