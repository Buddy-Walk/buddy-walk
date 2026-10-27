import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAlignedHeadingInstruction,
  buildBesideBuildingInstruction,
  buildClosedNowNotice,
  buildCloseRangeNoTurnInstruction,
  buildHeadingConflictInstruction,
  buildLastMetersApproachInstruction,
  buildLastMetersDistanceSentence,
  buildLastMetersRetakeInstruction,
  buildLastMetersSourceNote,
  buildLastMetersTurnInstruction,
  calculateLastMetersConfidence,
  compareCompassAndPanoramaHeadings,
  isDestinationBearingReliable,
  isLastMetersHeadingAligned,
  LAST_METERS_HEADING_CONFLICT_MAX_SCORE,
  lastMetersHeadingDifference,
  LAST_METERS_HEADINGS,
  LAST_METERS_PANORAMA_FOV_DEGREES,
  LAST_METERS_DESTINATION_REFERENCE_RADIUS_METERS,
  LAST_METERS_GPS_ALLOWANCE_MAX_METERS,
  parseDestinationVisibility,
  parseLastMetersHeading,
  resolveExactModeGate,
  resolveVerifiedTargetHeading,
  shouldUseDestinationReference,
  snapLastMetersHeading,
  streetViewImageryAgeYears,
} from "../../server/utils/lastMetersNavigation";

test("parseLastMetersHeading accepts a single valid panorama heading", () => {
  assert.equal(parseLastMetersHeading("315"), 315);
  assert.equal(parseLastMetersHeading("The matching view is 45 degrees."), 45);
  assert.equal(parseLastMetersHeading("360"), 0);
});

test("parseLastMetersHeading maps a VIEW index to that tile's heading", () => {
  // Sep 30 Dunkin': Step 2 answered "2" because the overlay said VIEW 2.
  assert.equal(parseLastMetersHeading("2"), 22.5);
  assert.equal(parseLastMetersHeading("VIEW 2"), 22.5);
  assert.equal(parseLastMetersHeading("1"), 0);
  assert.equal(parseLastMetersHeading("8"), 157.5);
  assert.equal(parseLastMetersHeading("VIEW 16 | 337.5 DEG"), 337.5);
  for (const heading of LAST_METERS_HEADINGS) {
    assert.equal(parseLastMetersHeading(String(heading)), heading);
  }
  assert.equal(parseLastMetersHeading("22.7"), null);
  assert.equal(parseLastMetersHeading("-22.5"), null);
  assert.equal(parseLastMetersHeading("22.5 or 337.5"), null);
});

test("parseLastMetersHeading rejects uncertain, conflicting, and invalid responses", () => {
  assert.equal(parseLastMetersHeading("NOT_VISIBLE"), null);
  assert.equal(parseLastMetersHeading("The target is not in view, maybe 315."), null);
  assert.equal(parseLastMetersHeading("45 or 90"), null);
  assert.equal(parseLastMetersHeading("2 or 3"), null);
  assert.equal(parseLastMetersHeading("22"), null);
  assert.equal(parseLastMetersHeading(""), null);
});

test("buildLastMetersTurnInstruction always chooses the shortest safe turn", () => {
  assert.equal(
    buildLastMetersTurnInstruction(225, 315),
    "Turn 90 degrees to your right."
  );
  assert.equal(
    buildLastMetersTurnInstruction(315, 0),
    "Turn 45 degrees to your right."
  );
  assert.equal(
    buildLastMetersTurnInstruction(45, 315),
    "Turn 90 degrees to your left."
  );
  assert.equal(
    buildLastMetersTurnInstruction(0, 180),
    "Turn around 180 degrees without moving forward."
  );
  assert.equal(
    buildLastMetersTurnInstruction(90, 90),
    "No turn needed. Keep facing forward."
  );
});

test("buildLastMetersTurnInstruction rejects non-finite headings", () => {
  assert.throws(() => buildLastMetersTurnInstruction(Number.NaN, 45));
  assert.throws(() => buildLastMetersTurnInstruction(0, Number.POSITIVE_INFINITY));
});

test("raw headings near a sector boundary do not flip between left and right", () => {
  // Starbucks 9/11 and 9/14: snapping 67 -> 45 and 68 -> 90 used to say "45 right".
  assert.equal(buildLastMetersTurnInstruction(67, 68), "No turn needed. Keep facing forward.");
  assert.equal(buildLastMetersTurnInstruction(68, 67), "No turn needed. Keep facing forward.");
  assert.equal(buildLastMetersTurnInstruction(355, 5), "No turn needed. Keep facing forward.");
});

test("small corrections use slight-turn wording", () => {
  assert.equal(
    buildLastMetersTurnInstruction(100, 75),
    "Turn slightly to your left, about 25 degrees."
  );
  assert.equal(
    buildLastMetersTurnInstruction(350, 22),
    "Turn slightly to your right, about 30 degrees."
  );
  assert.equal(buildLastMetersTurnInstruction(0, 62), "Turn 60 degrees to your right.");
});

test("confidence can never be high when compass and panorama disagree", () => {
  // McDonald's 9/22: 14 m GPS, panorama and destination matched, compass disagreed -> was 0.77 HIGH.
  const conflict = calculateLastMetersConfidence({
    gpsAccuracyMeters: 14,
    panoramaCurrentViewMatched: true,
    compassPanoramaAgrees: false,
    destinationVisuallyMatched: true,
    destinationReferenceVerified: false,
  });
  assert.equal(conflict.level, "low");
  assert.ok(conflict.score <= LAST_METERS_HEADING_CONFLICT_MAX_SCORE);
  assert.ok(conflict.reasons.includes("Compass and panorama headings disagree."));
});

test("a medium compass calibration lowers confidence", () => {
  const input = {
    gpsAccuracyMeters: 8,
    panoramaCurrentViewMatched: true,
    compassPanoramaAgrees: true,
    destinationVisuallyMatched: true,
    destinationReferenceVerified: false,
  };
  const calibrated = calculateLastMetersConfidence({ ...input, compassAccuracyLevel: 3 });
  const medium = calculateLastMetersConfidence({ ...input, compassAccuracyLevel: 2 });
  assert.ok(medium.score < calibrated.score);
  assert.ok(medium.reasons.includes("Phone compass calibration is not high."));
});

test("map bearing is not trusted when the user is closer than the GPS error", () => {
  // Luckin Coffee 9/22 at 4 m and 16 Handles 9/23 at 5-10 m gave contradictory turns.
  assert.equal(isDestinationBearingReliable(4), false);
  assert.equal(isDestinationBearingReliable(9, 5), false);
  assert.equal(isDestinationBearingReliable(12, 20), false);
  assert.equal(isDestinationBearingReliable(52, 14), true);
  assert.equal(isDestinationBearingReliable(16), true);
});

test("withheld-turn messages never contain a turn instruction", () => {
  const conflict = buildHeadingConflictInstruction("McDonald's", 52);
  const closeRange = buildCloseRangeNoTurnInstruction("16 Handles", 5);
  for (const message of [conflict, closeRange]) {
    assert.doesNotMatch(message, /\bturn (?:\d+|around|slightly)/i);
    assert.match(message, /will not guess a turn/);
  }
  assert.match(conflict, /^McDonald's is about 150 feet away/);
  assert.match(closeRange, /^You are within about 15 feet of 16 Handles\./);
});

test("close-range guidance states how far the destination is after the turn", () => {
  assert.equal(
    buildLastMetersDistanceSentence("Auntie Anne's", 4),
    "After turning, Auntie Anne's is about 15 feet ahead."
  );
  assert.equal(
    buildLastMetersDistanceSentence("Frank's Pizza", 3, false),
    "Frank's Pizza is about 10 feet ahead."
  );
  assert.equal(
    buildLastMetersDistanceSentence("Target", 66),
    "After turning, Target is about 200 feet away in that direction. Continue with your primary navigation."
  );
  assert.throws(() => buildLastMetersDistanceSentence("Target", -1));
});

test("far-away guidance names the branch it resolved", () => {
  assert.equal(
    buildLastMetersApproachInstruction("McDonald's", 335, 45, "160 Broadway, New York"),
    "The nearest McDonald's I found, at 160 Broadway, New York, is roughly 1,100 feet to the northeast. " +
      "Continue with your primary navigation and use Last Meters again when you are within about 800 feet. " +
      "If you are at a different McDonald's, add the street name and try again."
  );
  assert.match(
    buildAlignedHeadingInstruction("Shake Shack", 1_100, "691 8th Ave"),
    /^The nearest Shake Shack I found, at 691 8th Ave, is roughly .* add the street name and try again\.$/
  );
});

test("parseDestinationVisibility only accepts an exact visible result", () => {
  assert.equal(parseDestinationVisibility("VISIBLE"), true);
  assert.equal(parseDestinationVisibility(" visible "), true);
  assert.equal(parseDestinationVisibility("NOT_VISIBLE"), false);
  assert.equal(parseDestinationVisibility("The storefront is visible."), false);
});

test("snapLastMetersHeading chooses the nearest panorama direction", () => {
  assert.equal(snapLastMetersHeading(12), 22.5);
  assert.equal(snapLastMetersHeading(44), 45);
  assert.equal(snapLastMetersHeading(338), 337.5);
  assert.equal(snapLastMetersHeading(359), 0);
  assert.equal(snapLastMetersHeading(-46), 315);
  assert.throws(() => snapLastMetersHeading(Number.NaN));
});

test("buildLastMetersApproachInstruction gives only rough far-away guidance", () => {
  assert.equal(
    buildLastMetersApproachInstruction("Whole Foods", 1_609.344, 47),
    "Whole Foods is roughly 1.0 miles to the northeast. Continue with your primary navigation and use Last Meters again when you are within about 800 feet."
  );
  assert.match(
    buildLastMetersApproachInstruction("FedEx", 300, 180),
    /^FedEx is roughly 1,000 feet to the south\./
  );
  assert.throws(() =>
    buildLastMetersApproachInstruction("FedEx", Number.NaN, 90)
  );
});

test("heading alignment handles compass wraparound", () => {
  assert.equal(lastMetersHeadingDifference(350, 10), 20);
  assert.equal(lastMetersHeadingDifference(10, 350), 20);
  assert.equal(isLastMetersHeadingAligned(350, 10), true);
  assert.equal(isLastMetersHeadingAligned(350, 30), false);
  assert.throws(() => isLastMetersHeadingAligned(0, 90, 181));
});

test("panorama heading is comparison-only and never replaces the compass", () => {
  assert.deepEqual(compareCompassAndPanoramaHeadings(92, 135), {
    compassHeading: 90,
    panoramaMatchedHeading: 135,
    authoritativeHeading: 90,
    differenceDegrees: 45,
    agrees: true,
  });
  assert.deepEqual(compareCompassAndPanoramaHeadings(undefined, 180), {
    compassHeading: null,
    panoramaMatchedHeading: 180,
    authoritativeHeading: null,
    differenceDegrees: undefined,
    agrees: undefined,
  });
  assert.deepEqual(compareCompassAndPanoramaHeadings(5, null), {
    compassHeading: 0,
    panoramaMatchedHeading: null,
    authoritativeHeading: 0,
    differenceDegrees: undefined,
    agrees: undefined,
  });
});

test("confidence fusion rewards independent agreement and flags weak localization", () => {
  const strong = calculateLastMetersConfidence({
    gpsAccuracyMeters: 8,
    panoramaCurrentViewMatched: true,
    compassPanoramaAgrees: true,
    destinationVisuallyMatched: true,
    destinationReferenceVerified: false,
  });
  assert.equal(strong.level, "high");
  assert.ok(strong.score >= 0.75);

  const weak = calculateLastMetersConfidence({
    gpsAccuracyMeters: 75,
    panoramaCurrentViewMatched: false,
    compassPanoramaAgrees: false,
    destinationVisuallyMatched: false,
    destinationReferenceVerified: false,
  });
  assert.equal(weak.level, "low");
  assert.ok(weak.reasons.length >= 3);
});

test("verified panorama target preserves precise front-to-behind guidance", () => {
  assert.equal(resolveVerifiedTargetHeading(180, 180), 180);
  assert.equal(resolveVerifiedTargetHeading(135, 180), null);
  assert.equal(resolveVerifiedTargetHeading(157.5, 180), 157.5);
  assert.equal(resolveVerifiedTargetHeading(0, 337.5), 0);
  assert.equal(resolveVerifiedTargetHeading(0, 180), null);
  assert.equal(buildLastMetersTurnInstruction(0, 180), "Turn around 180 degrees without moving forward.");
});

test("buildAlignedHeadingInstruction keeps aligned guidance rough", () => {
  assert.equal(
    buildAlignedHeadingInstruction("Whole Foods", 320),
    "Whole Foods is roughly 1,050 feet ahead on your current heading. Keep this heading and continue with your primary navigation."
  );
});

test("close aligned guidance does not inflate the distance to 50 feet", () => {
  assert.equal(
    buildAlignedHeadingInstruction("CVS", 3),
    "CVS is roughly 10 feet ahead on your current heading. Keep this heading and continue with your primary navigation."
  );
  assert.equal(
    buildAlignedHeadingInstruction("Starbucks", 6),
    "Starbucks is roughly 20 feet ahead on your current heading. Keep this heading and continue with your primary navigation."
  );
});

test("panorama sectors cover 360 degrees once without overlap", () => {
  assert.equal(LAST_METERS_HEADINGS.length, 16);
  assert.equal(LAST_METERS_HEADINGS.length * LAST_METERS_PANORAMA_FOV_DEGREES, 360);
  for (let index = 1; index < LAST_METERS_HEADINGS.length; index += 1) {
    assert.equal(
      LAST_METERS_HEADINGS[index] - LAST_METERS_HEADINGS[index - 1],
      LAST_METERS_PANORAMA_FOV_DEGREES
    );
  }
});

test("destination references are limited to the same frontage", () => {
  assert.equal(shouldUseDestinationReference(10, 10), false);
  assert.equal(shouldUseDestinationReference(10, 2), true);
  assert.equal(shouldUseDestinationReference(10, 8), true);
  assert.equal(shouldUseDestinationReference(10, 8.01), false);
  assert.equal(shouldUseDestinationReference(10, undefined), true);
  assert.equal(
    shouldUseDestinationReference(
      LAST_METERS_DESTINATION_REFERENCE_RADIUS_METERS - 1
    ),
    true
  );
  assert.equal(
    shouldUseDestinationReference(
      LAST_METERS_DESTINATION_REFERENCE_RADIUS_METERS
    ),
    true
  );
  assert.equal(
    shouldUseDestinationReference(
      LAST_METERS_DESTINATION_REFERENCE_RADIUS_METERS + 1
    ),
    false
  );
  assert.throws(() => shouldUseDestinationReference(Number.NaN));
});

test("Citi close-range aligned wording does not claim GPS proves the door is ahead", () => {
  const aligned = buildCloseRangeNoTurnInstruction("Citi", 10, isLastMetersHeadingAligned(325, 321), "2016-09");
  assert.match(aligned, /compass agrees/);
  assert.match(aligned, /2016-09/);
  assert.match(aligned, /too uncertain/);
  assert.doesNotMatch(aligned, /Face the storefront|Turn \d|immediately in front/);
  const opposite = buildCloseRangeNoTurnInstruction("Citi", 8, isLastMetersHeadingAligned(136, 321), "2016-09");
  assert.match(opposite, /will not guess a turn/);
});

test("Test B guidance asks the user to move one block and retake", () => {
  assert.equal(
    buildLastMetersRetakeInstruction("Whole Foods", 120, 90),
    "Whole Foods is not visible from this block and is roughly 400 feet to the east. Continue with your primary navigation for another block, then stop safely and take a new photo."
  );
});

test("resolveExactModeGate requires accurate GPS and includes its uncertainty", () => {
  assert.deepEqual(resolveExactModeGate(240), { exact: false, allowanceMeters: 0, widened: false });
  assert.deepEqual(resolveExactModeGate(240, 10), { exact: true, allowanceMeters: 0, widened: false });
  assert.deepEqual(resolveExactModeGate(241, 10), { exact: false, allowanceMeters: 0, widened: false });
  assert.deepEqual(resolveExactModeGate(280, 40), { exact: false, allowanceMeters: 0, widened: false });
  assert.deepEqual(resolveExactModeGate(300, 40), { exact: false, allowanceMeters: 0, widened: false });
  assert.deepEqual(resolveExactModeGate(340, 150), {
    exact: false,
    allowanceMeters: 0,
    widened: false,
  });
  assert.equal(resolveExactModeGate(360, 150).exact, false);
  assert.equal(resolveExactModeGate(260, Number.NaN).exact, false);
  assert.throws(() => resolveExactModeGate(-1));
});

test("streetViewImageryAgeYears reads Street View capture dates", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  assert.equal(streetViewImageryAgeYears("2016-09", now), 10);
  assert.equal(streetViewImageryAgeYears("2026-04", now), 5 / 12);
  assert.equal(streetViewImageryAgeYears("2020", now), 6.25);
  assert.equal(streetViewImageryAgeYears(undefined, now), undefined);
  assert.equal(streetViewImageryAgeYears("unknown", now), undefined);
});

test("calculateLastMetersConfidence flags stale Street View imagery", () => {
  const evidence = {
    gpsAccuracyMeters: 10,
    compassAccuracyLevel: 3,
    panoramaCurrentViewMatched: true,
    compassPanoramaAgrees: true,
    destinationVisuallyMatched: true,
    destinationReferenceVerified: false,
  };
  const fresh = calculateLastMetersConfidence({ ...evidence, panoramaAgeYears: 0.5 });
  const stale = calculateLastMetersConfidence({ ...evidence, panoramaAgeYears: 10 });
  assert.ok(Math.abs(fresh.score - stale.score - 0.05) < 1e-9);
  assert.deepEqual(fresh.reasons, []);
  assert.ok(stale.reasons.includes("Street View imagery is about 10 years old."));
});

test("Last Meters answers cite their source and Google's closed status", () => {
  assert.equal(buildLastMetersSourceNote(null), " Source: Google Maps.");
  assert.equal(
    buildLastMetersSourceNote("2016-09"),
    " Source: Google Maps and Street View imagery from 2016-09."
  );
  assert.equal(buildLastMetersSourceNote(undefined), " Source: Google Maps and Street View.");
  assert.equal(buildClosedNowNotice("The UPS Store"), " Google Maps lists The UPS Store as closed right now.");
  assert.equal(buildClosedNowNotice("Citi", true), " Google Maps lists Citi as temporarily closed.");
});

test("beside-building guidance does not send the user to another block", () => {
  const text = buildBesideBuildingInstruction("Brookfield Place", 140, 180);
  assert.equal(
    text,
    "You appear to be beside Brookfield Place, which may have more than one entrance. " +
      "I could not confirm an entrance in front of you in Street View. " +
      "The entrance listed on Google Maps is roughly 450 feet to the south. " +
      "If you find a door here, ask someone nearby whether it is open to the public."
  );
  assert.doesNotMatch(text, /not visible from this block/);
});
