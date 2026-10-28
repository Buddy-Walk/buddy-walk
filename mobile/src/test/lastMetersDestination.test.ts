import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import axios from "axios";
import { findEntrance, verifyDestination } from "../../server/services/lastMetersDestination";
import { LastMetersTrial } from "../../server/services/lastMetersTrial";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";
import { strictLastMetersGuidancePolicy } from "../../server/utils/lastMetersGuidancePolicy";
import type { LatLng } from "../../server/services/googleMaps";
import type { VerifiedNearbyDestination } from "../../server/services/verifiedDestination";
import type { LastMetersRequestInput } from "../../server/utils/lastMetersReplay";
import { setTestEnv } from "./testEnv";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const REQUEST: LastMetersRequestInput = { destination: "McDonald's", lat: 40.7, lng: -74, gpsAccuracyMeters: 14 };
/** Straight north of the user, about 50 meters away. */
const NEAR = { lat: 40.70045, lng: -74 };

/** The Verified destination findEntrance starts from: about 56 meters north of the user. */
const DESTINATION: VerifiedNearbyDestination = {
  placeId: "mcdonalds",
  placeName: "McDonald's",
  placeAddress: "10 Test Street",
  types: ["restaurant"],
  location: { lat: 40.7005, lng: -74 },
  distanceMeters: 56,
  candidateSummary: "McDonald's, 56 meters",
  placeCandidates: [],
  placesSearches: ["nearby"],
  openNow: true,
  businessStatus: "OPERATIONAL",
};

function place(location: LatLng, placeId = "mcdonalds", vicinity = "10 Test Street", extra: object = {}) {
  return { place_id: placeId, name: "McDonald's", vicinity, geometry: { location }, types: ["restaurant"], ...extra };
}

/** What Google answers: Nearby Search results and the Geocoding building, if any, or an error for every request. */
interface Google {
  places: object[];
  building?: object;
  failure?: Error;
}

/** Fake Google, record what the Trial saves, and start a Trial for REQUEST. */
function arrange(t: TestContext, google: Google) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  setTestEnv(t, { GOOGLE_MAPS_API_KEY: "test-maps" });
  const requests: string[] = [];
  t.mock.method(axios, "get", async (url: string) => {
    requests.push(url);
    if (google.failure) throw google.failure;
    if (url.includes("/place/nearbysearch/")) {
      return { data: google.places.length ? { status: "OK", results: google.places } : { status: "ZERO_RESULTS", results: [] } };
    }
    if (url.includes("/place/textsearch/")) return { data: { status: "ZERO_RESULTS", results: [] } };
    if (url.includes("/geocode/")) return { data: google.building ? { status: "OK", results: [google.building] } : { status: "ZERO_RESULTS" } };
    return assert.fail(`Unexpected Google request: ${url}`);
  });
  const rows: Record<string, any>[] = [];
  t.mock.method(lastMetersTestLogService, "record", async (row: Record<string, any>) => {
    rows.push(row);
    return `trial-${rows.length}`;
  });
  // A replay saves no photo of its own, so the placeholder image is never compressed.
  const trial = new LastMetersTrial({
    request: REQUEST, image: "data:image/jpeg;base64,AAAA",
    options: { retry: { retryOf: "original-1", panoramaMode: "fresh", defaultsApplied: [], replayInput: { receivedAt: NOW } as any } },
    policy: strictLastMetersGuidancePolicy,
  });
  /** End the Trial so its saved row shows what the step logged. */
  const saved = async () => {
    await trial.answer({}, { success: true });
    return rows[0];
  };
  return { trial, requests, rows, saved };
}

test("verifyDestination returns the nearest matching place and logs the candidates it ranked", async t => {
  const { trial, saved } = arrange(t, { places: [place(NEAR)] });

  const result = await verifyDestination(trial, REQUEST, "McDonald's");

  assert.equal(result.kind, "ok");
  const destination = result.kind === "ok" ? result.value : assert.fail();
  assert.deepEqual(
    { placeId: destination.placeId, placeAddress: destination.placeAddress, location: destination.location, distanceMeters: Math.round(destination.distanceMeters) },
    { placeId: "mcdonalds", placeAddress: "10 Test Street", location: NEAR, distanceMeters: 50 },
  );
  const row = await saved();
  assert.deepEqual(row.dataSources, ["google_places"]);
  assert.equal(row.destinationPlaceName, "McDonald's");
  assert.deepEqual(row.steps.map((step: any) => [step.name, step.model, step.success]), [["destination_candidates", "google-places", true]]);
});

test("verifyDestination ends the run when no nearby place matches, saving what Google searched", async t => {
  const { trial, rows } = arrange(t, { places: [] });

  const result = await verifyDestination(trial, REQUEST, "McDonald's");

  assert.equal(result.kind, "exit");
  const answer = result.kind === "exit" ? result.result : assert.fail();
  const output = "I could not verify a nearby McDonald's from your current location. Try a more specific name or street address. Source: Google Maps.";
  assert.equal(answer.kind, "response");
  assert.deepEqual(answer.kind === "response" && answer.body, {
    output, testLogId: "trial-1", mode: undefined, testScenario: "destination_unverified", warning: "destination_not_verified",
  });
  const row = rows[0];
  assert.deepEqual(
    { success: row.success, error: row.error, finalOutput: row.finalOutput, placesSearches: row.placesSearches, dataSources: row.dataSources },
    { success: false, error: "destination_not_verified", finalOutput: output, placesSearches: ["nearby", "text"], dataSources: ["google_places"] },
  );
  assert.deepEqual(row.steps.map((step: any) => [step.name, step.response, step.success]), [["proximity_gate", "DESTINATION_NOT_VERIFIED", false]]);
});

test("verifyDestination ends the run when Google Places fails, saving the error", async t => {
  const { trial, rows } = arrange(t, { places: [], failure: new Error("Request failed with status code 503") });

  const result = await verifyDestination(trial, REQUEST, "McDonald's");

  assert.equal(result.kind === "exit" && result.result.kind === "response" && result.result.body.warning, "destination_not_verified");
  assert.deepEqual(rows[0].dataSources, [], "no Places answer, so no Places source");
  assert.deepEqual(rows[0].steps.map((step: any) => [step.name, step.error]), [["proximity_gate", "Request failed with status code 503"]]);
});

test("verifyDestination asks for the street address when another branch is about as close", async t => {
  const { trial, rows } = arrange(t, { places: [place(NEAR), place({ lat: 40.70046, lng: -74 }, "mcdonalds-two", "12 Test Street")] });

  const result = await verifyDestination(trial, REQUEST, "McDonald's");

  assert.equal(result.kind, "exit");
  const answer = result.kind === "exit" ? result.result : assert.fail();
  assert.deepEqual(answer.kind === "response" && answer.body.output,
    "I found more than one nearby McDonald's. Please specify the street address: 10 Test Street or 12 Test Street.");
  assert.deepEqual(rows[0].safetyReasons, ["destination_branch_ambiguous"]);
});

test("verifyDestination ignores a permanently closed branch at the same distance", async t => {
  const { trial } = arrange(t, {
    places: [place(NEAR), place({ lat: 40.70046, lng: -74 }, "mcdonalds-two", "12 Test Street", { business_status: "CLOSED_PERMANENTLY" })],
  });

  const result = await verifyDestination(trial, REQUEST, "McDonald's");

  assert.equal(result.kind === "ok" && result.value.placeId, "mcdonalds");
});

test("findEntrance aims at the map pin when Google lists no building", async t => {
  const { trial, requests, saved } = arrange(t, { places: [] });

  const { entrance, closedNotice } = await findEntrance(trial, REQUEST, DESTINATION);

  assert.deepEqual(entrance, { source: "places_pin", location: { lat: 40.7005, lng: -74 }, distanceMeters: 56 });
  assert.equal(closedNotice, "");
  assert.equal(requests.filter(url => url.includes("/geocode/")).length, 1);
  const row = await saved();
  assert.deepEqual(
    { entranceSource: row.entranceSource, entranceLat: row.entranceLat, destinationDistanceMeters: row.destinationDistanceMeters, steps: row.steps },
    { entranceSource: "places_pin", entranceLat: undefined, destinationDistanceMeters: 56, steps: [] },
  );
});

test("findEntrance falls back to the map pin when the Geocoding request fails", async t => {
  const { trial } = arrange(t, { places: [], failure: new Error("timeout of 8000ms exceeded") });
  t.mock.method(console, "warn", () => undefined);

  const { entrance } = await findEntrance(trial, REQUEST, DESTINATION);

  assert.deepEqual(entrance, { source: "places_pin", location: { lat: 40.7005, lng: -74 }, distanceMeters: 56 });
});

test("findEntrance aims at the listed entrance nearest the user and notes when they are beside the building", async t => {
  // The outline's south edge is about 17 meters north of the user, within the 20 meter allowance.
  const outline = [[-74.0002, 40.70015], [-73.9998, 40.70015], [-73.9998, 40.7006], [-74.0002, 40.7006], [-74.0002, 40.70015]];
  const { trial, saved } = arrange(t, { places: [], building: {
    buildings: [{ place_id: "mcdonalds", building_outlines: [{ display_polygon: { type: "Polygon", coordinates: [outline] } }] }],
    entrances: [
      { location: { lat: 40.7004, lng: -74 }, building_place_id: "mcdonalds" },
      { location: { lat: 40.7006, lng: -74 }, building_place_id: "mcdonalds" },
    ],
  } });

  const { entrance } = await findEntrance(trial, REQUEST, DESTINATION);

  assert.deepEqual({ ...entrance, distanceMeters: Math.round(entrance.distanceMeters) },
    { source: "geocoding_entrance", location: { lat: 40.7004, lng: -74 }, distanceMeters: 44, besideBuilding: true });
  const row = await saved();
  assert.deepEqual(
    { entranceSource: row.entranceSource, entranceLat: row.entranceLat, besideBuilding: row.besideBuilding, dataSources: row.dataSources },
    { entranceSource: "geocoding_entrance", entranceLat: 40.7004, besideBuilding: true, dataSources: ["google_building_entrances"] },
  );
  assert.deepEqual(row.steps.map((step: any) => [step.name, step.response, step.model, step.success]),
    [["building_entrances", "NEAREST_ENTRANCE: 44 meters (2 listed); USER_BESIDE_BUILDING", "google-geocoding", true]]);
});

test("findEntrance keeps the map pin, noting the outline, when the building lists no entrances", async t => {
  const { trial, saved } = arrange(t, { places: [], building: { buildings: [{ place_id: "mcdonalds" }], entrances: [] } });

  const { entrance } = await findEntrance(trial, REQUEST, DESTINATION);

  assert.deepEqual(entrance, { source: "places_pin", location: { lat: 40.7005, lng: -74 }, distanceMeters: 56, besideBuilding: false });
  const row = await saved();
  assert.deepEqual(row.steps.map((step: any) => [step.name, step.response, step.success]),
    [["building_entrances", "NO_ENTRANCES_LISTED", false]]);
});

test("findEntrance ignores another building's entrances for a small business inside it", async t => {
  const { trial } = arrange(t, { places: [], building: {
    buildings: [{ place_id: "office-tower" }], entrances: [{ location: { lat: 40.7004, lng: -74 }, building_place_id: "office-tower" }],
  } });

  const { entrance } = await findEntrance(trial, REQUEST, DESTINATION);

  assert.equal(entrance.source, "places_pin");
  assert.equal(entrance.besideBuilding, undefined);
});

test("findEntrance warns when Google lists the destination as closed", async t => {
  const { trial } = arrange(t, { places: [] });

  const closedNow = await findEntrance(trial, REQUEST, { ...DESTINATION, openNow: false });
  const temporarilyClosed = await findEntrance(trial, REQUEST, { ...DESTINATION, openNow: false, businessStatus: "CLOSED_TEMPORARILY" });

  assert.equal(closedNow.closedNotice, " Google Maps lists McDonald's as closed right now.");
  assert.equal(temporarilyClosed.closedNotice, " Google Maps lists McDonald's as temporarily closed.");
});
