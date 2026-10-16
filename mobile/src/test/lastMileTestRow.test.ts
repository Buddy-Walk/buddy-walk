import assert from "node:assert/strict";
import test from "node:test";
import {
  imagePlaceholder,
  imageStatsOf,
  isStoredImage,
  toLastMileTestResponse,
  toLastMileTestSummaryResponse,
} from "../../server/utils/lastMileTestRow";

const PANORAMA = "data:image/jpeg;base64,AAAA";
const PHOTO = "data:image/jpeg;base64,BBBBBB";

test("isStoredImage only accepts data URLs", () => {
  assert.equal(isStoredImage(PANORAMA), true);
  assert.equal(isStoredImage(""), false);
  assert.equal(isStoredImage(undefined), false);
  assert.equal(isStoredImage("[base64 image 27 chars]"), false);
  assert.equal(isStoredImage("https://example.com/pano.jpg"), false);
});

test("imagePlaceholder summarizes image length and leaves missing images empty", () => {
  assert.equal(imagePlaceholder(PANORAMA), `[base64 image ${PANORAMA.length} chars]`);
  assert.equal(imagePlaceholder(""), "");
  assert.equal(imagePlaceholder(undefined), "");
});

test("toLastMileTestResponse strips images but keeps presence flags for list views", () => {
  const row = toLastMileTestResponse(
    { destination: "CVS", userPhoto: PHOTO, panoramaPhoto: PANORAMA },
    false
  );
  assert.equal(row.destination, "CVS");
  assert.equal(row.hasUserPhoto, true);
  assert.equal(row.hasPanorama, true);
  assert.equal(row.hasDestinationPhoto, false);
  assert.equal(row.userPhoto, `[base64 image ${PHOTO.length} chars]`);
  assert.equal(row.panoramaPhoto, `[base64 image ${PANORAMA.length} chars]`);
  assert.equal(row.destinationPhoto, "");
});

test("toLastMileTestResponse reports no panorama for approach-mode rows", () => {
  const row = toLastMileTestResponse({ userPhoto: PHOTO }, false);
  assert.equal(row.hasPanorama, false);
  assert.equal(row.panoramaPhoto, "");
});

test("rows read without images produce the same list response as stripping them", () => {
  // Regression test: rows read without images produce the same list response as stripping them.
  const rows: { destination: string; userPhoto?: string; panoramaPhoto?: string; destinationPhoto?: string }[] = [
    { destination: "CVS", userPhoto: PHOTO, panoramaPhoto: PANORAMA },
    { destination: "UPS", userPhoto: PHOTO, panoramaPhoto: "[legacy]", destinationPhoto: "" },
    { destination: "Citi", userPhoto: PHOTO },
  ];
  for (const row of rows) {
    const { userPhoto, panoramaPhoto, destinationPhoto, ...rest } = row;
    const summary = { ...rest, imageStats: imageStatsOf({ userPhoto, panoramaPhoto, destinationPhoto }) };
    assert.deepEqual(toLastMileTestSummaryResponse(summary), toLastMileTestResponse(row, false));
  }
});

test("toLastMileTestResponse keeps the user photo but not Street View images", () => {
  const row = toLastMileTestResponse({ userPhoto: PHOTO, panoramaPhoto: PANORAMA }, true);
  assert.equal(row.userPhoto, PHOTO);
  assert.equal(row.panoramaPhoto, `[base64 image ${PANORAMA.length} chars]`);
  assert.equal(row.hasPanorama, true);
  assert.equal(row.hasUserPhoto, true);
});

test("single-trial opt-in returns saved panorama and destination images", () => {
  // Regression test: single-trial opt-in returns saved panorama and destination images.
  const original = { userPhoto: PHOTO, panoramaPhoto: PANORAMA, destinationPhoto: PHOTO };
  const row = toLastMileTestResponse(original, true, true);
  assert.equal(row.panoramaPhoto, PANORAMA);
  assert.equal(row.destinationPhoto, PHOTO);
  assert.equal(row.hasPanorama, true);
  assert.equal(row.hasDestinationPhoto, true);
  assert.equal(toLastMileTestResponse(original, false, true).panoramaPhoto, imagePlaceholder(PANORAMA));
});
