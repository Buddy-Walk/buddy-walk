import { describe, expect, it } from "vite-plus/test";

import { trialDetailFrom } from "./fixtures";
import { headingDiagnostics } from "./heading-diagnostics";

const facts = (fields: Parameters<typeof trialDetailFrom>[0] = {}) =>
  Object.fromEntries(headingDiagnostics(trialDetailFrom(fields)));

describe("headingDiagnostics", () => {
  it.each([
    [0, "0 (None)"],
    [1, "1 (Low)"],
    [2, "2 (Medium)"],
    [3, "3 (High)"],
  ])("preserves Expo accuracy %s at capture and submission", (level, label) => {
    const diagnostics = facts({
      replayInput: { compassAccuracyLevel: level, sensors: { latestHeadingAccuracyLevel: level } },
    });
    expect(diagnostics["Capture Expo Accuracy"]).toBe(label);
    expect(diagnostics["Latest Expo Accuracy"]).toBe(label);
  });

  it("shows a valid captured heading alongside an invalid latest reading without panorama fallback", () => {
    const diagnostics = facts({
      currentHeading: 120,
      compassHeading: 120,
      panoramaMatchedHeading: 120,
      replayInput: {
        heading: 116,
        compassAccuracyLevel: 3,
        sensors: {
          latestHeading: -1,
          latestHeadingAccuracyLevel: 1,
          latestHeadingReference: "true",
        },
      },
    });
    expect(diagnostics).toMatchObject({
      "Capture Heading": "116°",
      "Capture Expo Accuracy": "3 (High)",
      "Latest Heading": "-1°",
      "Latest Expo Accuracy": "1 (Low)",
      "Heading Reference": "True north",
      "Heading Validity": "Invalid",
    });
  });

  it.each([0, 90, 359.9])("treats the recorded latest heading %s as valid", (latestHeading) => {
    expect(facts({ replayInput: { sensors: { latestHeading } } })["Heading Validity"]).toBe(
      "Valid",
    );
  });

  it.each([-1, -90, 360, 720])("shows invalid heading %s explicitly", (latestHeading) => {
    const diagnostics = facts({ replayInput: { sensors: { latestHeading } } });
    expect(diagnostics["Latest Heading"]).toBe(`${latestHeading}°`);
    expect(diagnostics["Heading Validity"]).toBe("Invalid");
  });

  it("does not invent values for old Trials, even when derived headings exist", () => {
    const diagnostics = facts({ currentHeading: 120, panoramaMatchedHeading: 120 });
    for (const label of [
      "Capture Heading",
      "Capture Expo Accuracy",
      "Latest Heading",
      "Latest Expo Accuracy",
      "Heading Age (at backend receipt)",
      "Heading Validity",
    ]) {
      expect(diagnostics[label]).toBe("Not recorded");
    }
    expect(diagnostics["Heading Reference"]).toBe("Unknown");
  });

  it("does not substitute capture accuracy for missing latest accuracy", () => {
    const diagnostics = facts({
      replayInput: {
        compassAccuracyLevel: 3,
        sensors: { latestHeading: -1, latestHeadingAccuracyLevel: null },
      },
    });
    expect(diagnostics["Capture Expo Accuracy"]).toBe("3 (High)");
    expect(diagnostics["Latest Expo Accuracy"]).toBe("Not recorded");
  });

  it("labels unexpected accuracy values instead of interpreting them as no accuracy", () => {
    expect(
      facts({ replayInput: { sensors: { latestHeadingAccuracyLevel: -1 } } })[
        "Latest Expo Accuracy"
      ],
    ).toBe("-1 (Unknown)");
  });

  it("uses the saved backend receipt time for age, including a future-timestamp discrepancy", () => {
    expect(
      facts({ replayInput: { receivedAt: 10_000, sensors: { latestHeadingTimestamp: 8_750 } } })[
        "Heading Age (at backend receipt)"
      ],
    ).toBe("1250 ms");
    expect(
      facts({ replayInput: { receivedAt: 10_000, sensors: { latestHeadingTimestamp: 11_000 } } })[
        "Heading Age (at backend receipt)"
      ],
    ).toBe("-1000 ms");
  });

  it.each([
    ["magnetic", "Magnetic north"],
    ["unknown", "Unknown"],
    ["unrecognized", "Unknown"],
  ])("labels reference %s", (reference, label) => {
    expect(
      facts({ replayInput: { sensors: { latestHeadingReference: reference } } })[
        "Heading Reference"
      ],
    ).toBe(label);
  });
});
