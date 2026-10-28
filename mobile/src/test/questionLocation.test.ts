import "./doorfrontUri";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import axios from "axios";
import { describeLocation } from "../../server/services/questionLocation";
import { readQuestionRequest } from "../../server/services/questionRequest";
import type { textRequestBody } from "../../server/types";
import { setTestEnv } from "./testEnv";

const GOOGLE_KEY = "location-test-google";
const TIMES_SQUARE = { latitude: 40.7559, longitude: -73.9871, accuracy: 10 };
const ADDRESS = "1560 Broadway, New York, NY";

/** Fake Google geocoding over axios. Returns the URLs requested. */
function fakeGeocoding(t: TestContext) {
  setTestEnv(t, { GOOGLE_MAPS_API_KEY: GOOGLE_KEY });
  const urls: string[] = [];
  t.mock.method(axios, "get", async (url: string) => {
    urls.push(url);
    if (!url.includes("/geocode/json")) throw new Error(`Unexpected request: ${url}`);
    return { data: { results: [{ formatted_address: ADDRESS }] } };
  });
  return urls;
}

function describe(content: Partial<textRequestBody>) {
  const body: textRequestBody = { text: "What is around me?", coords: TIMES_SQUARE, ...content };
  return describeLocation(body, readQuestionRequest(body));
}

test("a Question is described by its street address", async (t) => {
  const urls = fakeGeocoding(t);

  assert.equal(await describe({}), `Current Address: ${ADDRESS} `);
  assert.deepEqual(urls, [`https://maps.googleapis.com/maps/api/geocode/json?latlng=40.7559,-73.9871&key=${GOOGLE_KEY}`]);
});

test("a Question's compass heading and orientation follow its street address", async (t) => {
  fakeGeocoding(t);

  const location = await describe({
    coords: { ...TIMES_SQUARE, heading: 270, orientation: { alpha: 10, beta: 20, gamma: 30 } },
  });

  assert.equal(
    location,
    `Current Address: ${ADDRESS} , Heading (Compass Direction): 270, Orientation - Alpha: 10, Beta: 20, Gamma: 30`,
  );
});

test("a Question's orientation is added without a compass heading", async (t) => {
  fakeGeocoding(t);

  const location = await describe({ coords: { ...TIMES_SQUARE, orientation: { alpha: 10, beta: null, gamma: 30 } } });

  assert.equal(location, `Current Address: ${ADDRESS} , Orientation - Alpha: 10, Beta: null, Gamma: 30`);
});

test("a Question that needs a verified nearby answer is described without its street address", async (t) => {
  const urls = fakeGeocoding(t);

  const location = await describe({
    text: "Directions to Citibank",
    coords: { ...TIMES_SQUARE, heading: 90 },
    analytics: { feature: "directions" },
  });

  assert.equal(location, ", Heading (Compass Direction): 90");
  assert.deepEqual(urls, []);
});

test("a photo or video Question is described without its street address", async (t) => {
  const urls = fakeGeocoding(t);
  const frames = ["data:image/jpeg;base64,storefront"];

  assert.equal(await describe({ image: frames, analytics: { feature: "photo_qa" } }), "");
  assert.equal(await describe({ image: frames, analytics: { feature: "video_qa" } }), "");
  assert.deepEqual(urls, []);
});

test("a Question without a location is described by nothing", async (t) => {
  const urls = fakeGeocoding(t);

  assert.equal(await describe({ coords: null }), "");
  assert.deepEqual(urls, []);
});
