import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLAY_INPUT_VERSION,
  assessReplay,
  buildReplayInput,
  hasReplayablePhoto,
  parseLastMetersRequest,
  photoHash,
  replayRequest,
  upgradeReplayInput,
  type ReplayUpgrade,
} from "../../server/utils/lastMetersReplay";
import type { LastMetersSensors } from "../../src/utils/lastMetersSafety";

const PHOTO = "data:image/jpeg;base64,BBBBBB";
const RECEIVED_AT = 1_800_000_000_000;

const sensors: LastMetersSensors = {
  photoCapturedAt: RECEIVED_AT,
  positionTimestamp: RECEIVED_AT,
  headingTimestamp: RECEIVED_AT,
  headingReference: "true",
  latestPosition: { lat: 40.7128, lng: -74.006, accuracy: 8, timestamp: RECEIVED_AT },
  latestHeading: 92.5,
  latestHeadingTimestamp: RECEIVED_AT,
  latestHeadingReference: "true",
};

const request = {
  destination: "CVS",
  lat: 40.7128,
  lng: -74.006,
  deviceHeading: 92.5,
  gpsAccuracyMeters: 8,
  compassAccuracyLevel: 3,
  sensors,
};

const snapshot = () => buildReplayInput(request, PHOTO, RECEIVED_AT);

test("parseLastMetersRequest reads the app request and drops unusable values", () => {
  assert.deepEqual(
    parseLastMetersRequest({
      destination: "  CVS ",
      lat: 40.7128,
      lng: -74.006,
      heading: 92.5,
      gpsAccuracyMeters: 8,
      compassAccuracyLevel: 3,
      sensors,
      image: PHOTO,
    }),
    request
  );
  const loose = parseLastMetersRequest({ destination: "CVS", lat: 1, lng: 2, heading: "north", sensors: "x" });
  assert.equal(loose?.deviceHeading, undefined);
  assert.equal(loose?.sensors, undefined);
});

test("parseLastMetersRequest rejects missing destination or unusable coordinates", () => {
  assert.equal(parseLastMetersRequest({ destination: " ", lat: 1, lng: 2 }), undefined);
  assert.equal(parseLastMetersRequest({ destination: "CVS", lat: null, lng: 2 }), undefined);
  assert.equal(parseLastMetersRequest({ destination: "CVS", lat: "40.7", lng: 2 }), undefined);
  assert.equal(parseLastMetersRequest({ destination: "CVS", lat: 91, lng: 2 }), undefined);
  assert.equal(parseLastMetersRequest({ destination: 42, lat: 1, lng: 2 }), undefined);
  assert.equal(parseLastMetersRequest(undefined), undefined);
});

test("buildReplayInput records the version, request time, sensors and photo hash", () => {
  assert.deepEqual(snapshot(), {
    schemaVersion: REPLAY_INPUT_VERSION,
    receivedAt: RECEIVED_AT,
    lat: request.lat,
    lng: request.lng,
    destination: "CVS",
    heading: 92.5,
    gpsAccuracyMeters: 8,
    compassAccuracyLevel: 3,
    sensors,
    originalPhotoSha256: photoHash(PHOTO),
    photoRepresentation: "stored-compressed",
  });
  assert.deepEqual(replayRequest(snapshot()), request);
});

test("hasReplayablePhoto rejects the empty proxy placeholder and placeholders", () => {
  assert.equal(hasReplayablePhoto(PHOTO), true);
  assert.equal(hasReplayablePhoto("data:,"), false);
  assert.equal(hasReplayablePhoto("[base64 image 27 chars]"), false);
  assert.equal(hasReplayablePhoto(undefined), false);
});

test("assessReplay runs a current snapshot as recorded", () => {
  const assessment = assessReplay({
    replayInput: snapshot(),
    userPhoto: PHOTO,
    panoId: "pano-1",
    panoramaDate: "2019-05",
    testScenario: "test_a_visible",
  });
  assert.equal(assessment.status, "replayable");
  assert.equal(assessment.sourceVersion, REPLAY_INPUT_VERSION);
  assert.deepEqual(assessment.defaultsApplied, []);
  assert.deepEqual(assessment.input, snapshot());
  assert.deepEqual(assessment.originalPanorama, {
    available: true,
    panoId: "pano-1",
    panoramaDate: "2019-05",
  });
});

test("assessReplay reads the photo flag on rows loaded without images", () => {
  assert.equal(assessReplay({ replayInput: snapshot(), userPhotoReplayable: true }).status, "replayable");
  assert.equal(assessReplay({ replayInput: snapshot(), userPhotoReplayable: false }).status, "not_replayable");
});

test("logs written before snapshots are blocked: they never recorded sensors", () => {
  const { sensors: _sensors, ...legacyRow } = request;
  const assessment = assessReplay({ ...legacyRow, userPhoto: PHOTO });
  assert.equal(assessment.status, "not_replayable");
  assert.equal(assessment.sourceVersion, 0);
  assert.equal(assessment.incompatible, true);
  assert.match(assessment.reason ?? "", /capture timestamps/);
  assert.equal(assessment.originalPanorama.available, false);
  assert.match(assessment.originalPanorama.reason ?? "", /pano ID/);
});

test("assessReplay prefers the stored snapshot over output fields on the row", () => {
  const assessment = assessReplay({
    ...request,
    destination: "Something else",
    replayInput: snapshot(),
    userPhoto: PHOTO,
  });
  assert.equal(assessment.input?.destination, "CVS");
});

test("assessReplay blocks trials with missing inputs, with a reason", () => {
  const noPhoto = assessReplay({ replayInput: snapshot(), userPhoto: "data:," });
  assert.equal(noPhoto.status, "not_replayable");
  assert.match(noPhoto.reason ?? "", /photo/);

  const noCoordinates = assessReplay({ replayInput: { ...snapshot(), lat: 0, lng: 0 }, userPhoto: PHOTO });
  assert.match(noCoordinates.reason ?? "", /coordinates/);

  const noDestination = assessReplay({ replayInput: { ...snapshot(), destination: "" }, userPhoto: PHOTO });
  assert.match(noDestination.reason ?? "", /destination/);
  assert.equal(noDestination.input, undefined);

  const noTime = assessReplay({ replayInput: { ...snapshot(), receivedAt: Number.NaN }, userPhoto: PHOTO });
  assert.match(noTime.reason ?? "", /received/);

  const noSensors = assessReplay({ replayInput: { ...snapshot(), sensors: undefined }, userPhoto: PHOTO });
  assert.equal(noSensors.status, "not_replayable");
  assert.match(noSensors.reason ?? "", /capture timestamps/);
});

test("assessReplay does not replay question-routed inputs", () => {
  const assessment = assessReplay({ replayInput: snapshot(), userPhoto: PHOTO, testScenario: "question_routed" });
  assert.equal(assessment.status, "not_replayable");
  assert.match(assessment.reason ?? "", /question/);
});

test("assessReplay refuses snapshots from a newer pipeline as incompatible", () => {
  const assessment = assessReplay({
    replayInput: { ...snapshot(), schemaVersion: REPLAY_INPUT_VERSION + 1 } as never,
    userPhoto: PHOTO,
  });
  assert.equal(assessment.status, "not_replayable");
  assert.equal(assessment.incompatible, true);
  assert.match(assessment.reason ?? "", /newer pipeline/);
});

test("upgrades chain, list filled-in values, and can block a replay", () => {
  const upgrades: Record<number, ReplayUpgrade> = {
    1: (input) => ({
      ok: true,
      input: { ...input, schemaVersion: 2, pitch: 0 },
      defaultsApplied: ["pitch: 0 (not recorded before v2)"],
    }),
    2: (input) =>
      input.heading === undefined
        ? { ok: false, reason: "Requires a compass heading, not recorded." }
        : { ok: true, input: { ...input, schemaVersion: 3 }, defaultsApplied: [] },
  };

  const withDefaults = assessReplay({ replayInput: snapshot(), userPhoto: PHOTO }, upgrades, 3);
  assert.equal(withDefaults.status, "replayable_with_defaults");
  assert.deepEqual(withDefaults.defaultsApplied, ["pitch: 0 (not recorded before v2)"]);

  const blocked = assessReplay(
    { replayInput: { ...snapshot(), heading: undefined }, userPhoto: PHOTO },
    upgrades,
    3
  );
  assert.equal(blocked.status, "not_replayable");
  assert.equal(blocked.incompatible, true);
  assert.match(blocked.reason ?? "", /compass heading/);
});

test("upgradeReplayInput reports a missing upgrade step instead of guessing", () => {
  const result = upgradeReplayInput({ schemaVersion: 0 }, {}, 1);
  assert.equal(result.ok, false);
  assert.equal(result.incompatible, true);
});

test("upgradeReplayInput rejects a step that does not advance the version", () => {
  const result = upgradeReplayInput(
    { schemaVersion: 0 },
    { 0: (input) => ({ ok: true, input, defaultsApplied: [] }) },
    1
  );
  assert.equal(result.ok, false);
});
