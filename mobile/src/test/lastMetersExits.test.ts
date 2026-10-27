import assert from "node:assert/strict";
import test, { snapshot, type TestContext } from "node:test";
import axios from "axios";
import OpenAI from "openai";
import sharp from "sharp";
import { LastMetersService } from "../../server/services/lastMetersService";
import { MobileLastMetersService } from "../../server/services/mobileLastMeters";
import { lastMetersTestLogService } from "../../server/services/lastMetersTestLog";
import type { LatLng } from "../../server/services/googleMaps";
import type { LastMetersRequestInput } from "../../server/utils/lastMetersReplay";
import { setTestEnv } from "./testEnv";

// Characterization tests: one per way runLastMeters can end, under each guidance policy that can
// reach it. Each compares the whole answer and the whole saved Trial row against
// lastMetersExits.test.ts.snapshot. After an intended change, review the diff and regenerate with
// `npx tsx --test-update-snapshots src/test/lastMetersExits.test.ts`.
// The snapshot path is process-wide, so another snapshot test would need its own resolver here.
snapshot.setResolveSnapshotPath(() => `${__filename}.snapshot`);

const NOW = Date.parse("2026-10-27T12:00:00Z");
const USER = { lat: 40.7, lng: -74 };
/** Destinations straight north of the user, about 50, 111 and 300 meters away. */
const NEAR = { lat: 40.70045, lng: -74 };
const MID = { lat: 40.701, lng: -74 };
const FAR = { lat: 40.7027, lng: -74 };

const services = {
  /** App requests (controllers/lastMetersController.ts). */
  mobile: () => new MobileLastMetersService(),
  /** The default service and strict policy, which dashboard retries use. */
  strict: () => new LastMetersService(),
};
type Policy = keyof typeof services;

type Vision = "scene" | "currentView" | "destination" | "reference" | "signText" | "landmarks";

/** The app request and what Google and OpenAI answer during one run. */
interface World {
  request: LastMetersRequestInput;
  /** Nearby Search results; the first is the destination. */
  places: object[];
  /** The Geocoding building and entrances result, if Google has one. */
  building?: object;
  directions: object;
  panoramaMetadata: object;
  vision: Record<Vision, string | Error>;
  /** Runs while the landmark guidance is being written. */
  duringGuidance?: (t: TestContext) => void;
}

function place(location: LatLng, placeId = "mcdonalds", vicinity = "10 Test Street") {
  return { place_id: placeId, name: "McDonald's", vicinity, geometry: { location }, types: ["restaurant"] };
}

function building(entrance: LatLng) {
  return { buildings: [{ place_id: "mcdonalds" }], entrances: [{ location: entrance, building_place_id: "mcdonalds" }] };
}

/** Move the destination and its listed entrance. */
function moveDestination(world: World, location: LatLng) {
  world.places = [place(location)];
  world.building = building(location);
}

/** Every piece of evidence agrees, so both policies give a precise turn. */
function verifiedTurnWorld(): World {
  return {
    request: {
      ...USER, destination: "McDonald's", deviceHeading: 90, gpsAccuracyMeters: 14, compassAccuracyLevel: 3,
      sensors: {
        photoCapturedAt: NOW, positionTimestamp: NOW, headingTimestamp: NOW, headingReference: "true",
        latestPosition: { ...USER, accuracy: 14, timestamp: NOW },
        latestHeading: 90, latestHeadingTimestamp: NOW, latestHeadingReference: "true",
      },
    },
    places: [place(NEAR)],
    building: building(NEAR),
    directions: { status: "OK", routes: [{ legs: [{
      start_location: USER, end_location: NEAR, distance: { value: 50 },
      steps: [{ travel_mode: "WALKING", start_location: USER, end_location: NEAR }],
    }] }] },
    panoramaMetadata: { status: "OK", pano_id: "outdoor-pano", copyright: "Google", date: "2025-01", location: USER },
    vision: {
      scene: "OUTDOOR",
      currentView: "90",
      destination: "0",
      reference: "NOT_VISIBLE",
      signText: "NO_TEXT",
      landmarks: "A recessed doorway is on the brick wall in your photo.",
    },
  };
}

function visionFor(prompt: string): Vision {
  if (prompt.startsWith("Classify the CAMERA")) return "scene";
  if (prompt.includes("center of the user's photo")) return "currentView";
  if (prompt.includes("Find the storefront, sign, or entrance")) return "destination";
  if (prompt.includes("destination-focused Street View image for")) return "reference";
  if (prompt.includes("Transcribe the business names")) return "signText";
  if (prompt.includes("orientation assistant for a blind pedestrian")) return "landmarks";
  return assert.fail(`Unexpected prompt: ${prompt}`);
}

const photoJpeg = (() => {
  // Noise so the JPEG passes the 10 KB usable-tile check.
  const pixels = Buffer.alloc(640 * 640 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 13 + Math.floor(i / 19)) % 256;
  return sharp(pixels, { raw: { width: 640, height: 640, channels: 3 } }).jpeg().toBuffer();
})();

/** JSON as the app and the Trial store see it, without timings or photo bytes. */
function comparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, field) => {
    if (key === "latencyMs" || key === "durationMs") return undefined;
    if (key === "originalPhotoSha256") return "<photo hash>";
    return typeof field === "string" && field.startsWith("data:image/") ? "<photo data URL>" : field;
  }));
}

/** Run one app request against the faked providers and collect everything it answered and saved. */
async function runExit(t: TestContext, policy: Policy, world: World) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  setTestEnv(t, { GOOGLE_MAPS_API_KEY: "test-maps", OPENAI_API_KEY: "test-openai" });
  const jpeg = await photoJpeg;
  t.mock.method(axios, "get", async (url: string) => {
    if (url.includes("/place/nearbysearch/")) {
      return { data: world.places.length ? { status: "OK", results: world.places } : { status: "ZERO_RESULTS", results: [] } };
    }
    if (url.includes("/place/textsearch/")) return { data: { status: "ZERO_RESULTS", results: [] } };
    if (url.includes("/geocode/")) return { data: world.building ? { status: "OK", results: [world.building] } : { status: "ZERO_RESULTS" } };
    if (url.includes("/directions/")) return { data: world.directions };
    if (url.includes("/streetview/metadata")) return { data: world.panoramaMetadata };
    if (url.includes("/streetview")) return { status: 200, data: jpeg };
    return assert.fail(`Unexpected Google request: ${url}`);
  });
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async (request: any) => {
    const vision = visionFor(request.messages[0].content);
    if (vision === "landmarks") world.duringGuidance?.(t);
    const answer = world.vision[vision];
    if (answer instanceof Error) throw answer;
    return { choices: [{ message: { content: answer } }], usage: { total_tokens: 10 } };
  });
  const trials: unknown[] = [];
  t.mock.method(lastMetersTestLogService, "record", async (row: unknown) => {
    trials.push(row);
    return `trial-${trials.length}`;
  });
  const reviewPanoramas: unknown[] = [];
  t.mock.method(lastMetersTestLogService, "attachPanorama", async (testLogId: string, panorama: unknown) => {
    reviewPanoramas.push({ testLogId, panorama });
  });

  const result = await services[policy]().runLastMeters(
    world.request, `data:image/jpeg;base64,${jpeg.toString("base64")}`, { requestPath: "/api/last-meters" },
  );
  if (result.kind === "response") await result.reviewPanorama;
  // The review promise is not part of the answer, and JSON leaves out undefined.
  return comparable({ answer: { ...result, reviewPanorama: undefined }, trials, reviewPanoramas });
}

const exits: { name: string; policies: Policy[]; arrange?: (world: World) => void }[] = [
  {
    // Strict only: the mobile policy's first sensor check never withholds.
    name: "first sensor check withholds the turn",
    policies: ["strict"],
    arrange: world => { world.request.sensors = undefined; },
  },
  {
    // Both policies.
    name: "question handed to the Question service",
    policies: ["mobile", "strict"],
    arrange: world => { world.request.destination = "When is the next A train?"; },
  },
  {
    // Both policies.
    name: "destination_not_verified",
    policies: ["mobile", "strict"],
    arrange: world => { world.places = []; },
  },
  {
    // Both policies.
    name: "destination_branch_ambiguous",
    policies: ["mobile", "strict"],
    arrange: world => { world.places.push(place({ lat: 40.70046, lng: -74 }, "mcdonalds-two", "12 Test Street")); },
  },
  {
    // Both policies.
    name: "heading_already_aligned",
    policies: ["mobile", "strict"],
    arrange: world => {
      moveDestination(world, FAR);
      world.request.deviceHeading = 0;
      world.request.sensors!.latestHeading = 0;
    },
  },
  {
    // Both policies.
    name: "destination_too_far",
    policies: ["mobile", "strict"],
    arrange: world => { moveDestination(world, FAR); },
  },
  {
    // Both policies.
    name: "no_validated_outdoor_panorama",
    policies: ["mobile", "strict"],
    arrange: world => { world.panoramaMetadata = { status: "ZERO_RESULTS" }; },
  },
  {
    // Mobile only: without a compass heading the strict policy's first sensor check withholds.
    name: "compass_heading_unavailable",
    policies: ["mobile"],
    arrange: world => { world.request.deviceHeading = undefined; },
  },
  {
    // Both policies.
    name: "heading_sources_disagree",
    policies: ["mobile", "strict"],
    arrange: world => { world.vision.currentView = "270"; },
  },
  {
    // Both policies. Too far for the reference photo and sign text backups, and the only
    // panorama nearby has already been tried.
    name: "destination_not_visible_move_closer",
    policies: ["mobile", "strict"],
    arrange: world => {
      moveDestination(world, MID);
      world.vision.destination = "NOT_VISIBLE";
    },
  },
  {
    // Both policies. As above, but the user stands beside the destination's building.
    name: "entrance_not_visually_confirmed beside the building",
    policies: ["mobile", "strict"],
    arrange: world => {
      moveDestination(world, MID);
      world.building = {
        buildings: [{ place_id: "mcdonalds", building_outlines: [{ display_polygon: { type: "Polygon", coordinates: [[
          [-74.0003, 40.70005], [-73.9997, 40.70005], [-73.9997, 40.7011], [-74.0003, 40.7011], [-74.0003, 40.70005],
        ]] } }] }],
        entrances: [{ location: MID, building_place_id: "mcdonalds" }],
      };
      world.vision.destination = "NOT_VISIBLE";
    },
  },
  {
    // Both policies. Neither the reference photo nor the sign text confirms the destination.
    name: "entrance_not_visually_confirmed after the backups",
    policies: ["mobile", "strict"],
    arrange: world => { world.vision.destination = "NOT_VISIBLE"; },
  },
  {
    // Both policies.
    name: "turn checks withhold the turn",
    policies: ["mobile", "strict"],
    arrange: world => { world.vision.currentView = "NOT_VISIBLE"; },
  },
  {
    // Strict only: the mobile policy judges sensors as of when the request arrived, so its late
    // check always agrees with its earlier turn check.
    name: "late sensor check withholds the turn",
    policies: ["strict"],
    arrange: world => { world.duringGuidance = t => t.mock.timers.tick(70_000); },
  },
  {
    // Both policies.
    name: "precise turn",
    policies: ["mobile", "strict"],
  },
  {
    // Both policies.
    name: "unexpected error answers 502",
    policies: ["mobile", "strict"],
    arrange: world => { world.vision.currentView = Object.assign(new Error("Internal server error"), { status: 500 }); },
  },
];

for (const exit of exits) {
  for (const policy of exit.policies) {
    test(`Last Meters exit: ${exit.name} (${policy} policy)`, async t => {
      const world = verifiedTurnWorld();
      exit.arrange?.(world);
      t.assert.snapshot(await runExit(t, policy, world));
    });
  }
}
