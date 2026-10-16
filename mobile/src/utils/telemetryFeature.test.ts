import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFeature,
  looksLikeBareDestination,
} from "./telemetryFeature";

test("bare business names and addresses are classified as directions", () => {
  // Regression test: bare business names and addresses are classified as directions.
  assert.equal(looksLikeBareDestination("FedEx"), true);
  assert.equal(looksLikeBareDestination("Whole Foods"), true);
  assert.equal(looksLikeBareDestination("38 Warren St"), true);
  assert.equal(classifyFeature({ text: "FedEx" }), "directions");
  assert.equal(classifyFeature({ text: "38 Warren St" }), "directions");
  assert.equal(classifyFeature({ text: "Take me to CVS" }), "directions");
});

test("questions and conversational text are not treated as bare destinations", () => {
  // Regression test: questions and conversational text are not treated as bare destinations.
  assert.equal(looksLikeBareDestination("Hello"), false);
  assert.equal(looksLikeBareDestination("What is FedEx?"), false);
  assert.equal(looksLikeBareDestination("Tell me about Whole Foods"), false);
  assert.equal(classifyFeature({ text: "Hello" }), "general");
  assert.equal(classifyFeature({ text: "What is FedEx?" }), "general");
});

