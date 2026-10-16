import assert from "node:assert/strict";
import test from "node:test";
import {
  describeNearbyPlaceCandidates,
  editDistance,
  extractNearbyPlaceQuery,
  isNearbyPlaceCandidateRelevant,
  looksLikeBareDestinationQuery,
  MAX_LOCAL_PLACE_DISTANCE_METERS,
  mergeNearbyPlaceCandidates,
  nearbyPlaceDistanceMeters,
  normalizeNearbyPlaceQuery,
  selectNearbyPlaceCandidate,
  selectNearbyPlaceCandidates,
  signTextMatchesPlaceName,
  summarizePlaceCandidates,
} from "../../server/utils/nearbyPlaces";

const manhattan = { lat: 40.758, lng: -73.9855 };

test("normalizeNearbyPlaceQuery removes proximity filler", () => {
  // Regression test: normalizeNearbyPlaceQuery removes proximity filler.
  assert.equal(normalizeNearbyPlaceQuery("closest FedEx near me"), "FedEx");
  assert.equal(normalizeNearbyPlaceQuery("Nearby pharmacy"), "pharmacy");
});

test("extractNearbyPlaceQuery isolates destinations from local requests", () => {
  // Regression test: extractNearbyPlaceQuery isolates destinations from local requests.
  assert.equal(
    extractNearbyPlaceQuery("Give me walking directions to FedEx near me."),
    "FedEx"
  );
  assert.equal(extractNearbyPlaceQuery("Where is the nearest Whole Foods?"), "Whole Foods");
  assert.equal(extractNearbyPlaceQuery("Find a pharmacy nearby"), "pharmacy");
  assert.equal(extractNearbyPlaceQuery("What is near me?"), null);
  assert.equal(extractNearbyPlaceQuery("Tell me about package delivery"), null);
});

test("extractNearbyPlaceQuery only accepts bare destinations when explicitly allowed", () => {
  // Regression test: extractNearbyPlaceQuery only accepts bare destinations when explicitly
  // allowed.
  assert.equal(extractNearbyPlaceQuery("FedEx"), null);
  assert.equal(extractNearbyPlaceQuery("FedEx", true), "FedEx");
  assert.equal(extractNearbyPlaceQuery("38 Warren St", true), "38 Warren St");
  assert.equal(extractNearbyPlaceQuery("Hello", true), null);
  assert.equal(extractNearbyPlaceQuery("What is FedEx?", true), null);
});

test("looksLikeBareDestinationQuery detects safe destination-shaped text", () => {
  // Regression test: looksLikeBareDestinationQuery detects safe destination-shaped text.
  assert.equal(looksLikeBareDestinationQuery("FedEx"), true);
  assert.equal(looksLikeBareDestinationQuery("Whole Foods"), true);
  assert.equal(looksLikeBareDestinationQuery("38 Warren St"), true);
  assert.equal(looksLikeBareDestinationQuery("Hello"), false);
  assert.equal(looksLikeBareDestinationQuery("What is FedEx?"), false);
});

test("isNearbyPlaceCandidateRelevant rejects fuzzy brand substitutions", () => {
  // Regression test: isNearbyPlaceCandidateRelevant rejects fuzzy brand substitutions.
  assert.equal(
    isNearbyPlaceCandidateRelevant(
      { name: "Burger Man", types: ["restaurant"], vicinity: "7th Avenue" },
      "Whataburger"
    ),
    false
  );
  assert.equal(
    isNearbyPlaceCandidateRelevant(
      { name: "FedEx Office Print & Ship Center", types: ["store"] },
      "FedEx"
    ),
    true
  );
  assert.equal(
    isNearbyPlaceCandidateRelevant(
      { name: "CVS", types: ["drugstore", "pharmacy", "store"] },
      "pharmacy"
    ),
    true
  );
});

test("selectNearbyPlaceCandidate chooses the nearest valid result", () => {
  // Regression test: selectNearbyPlaceCandidate chooses the nearest valid result.
  const selected = selectNearbyPlaceCandidate(
    [
      {
        place_id: "farther",
        name: "FedEx Downtown",
        geometry: { location: { lat: 40.72, lng: -74.0 } },
      },
      {
        place_id: "near",
        name: "FedEx Midtown",
        geometry: { location: { lat: 40.759, lng: -73.984 } },
      },
    ],
    manhattan
  );

  assert.equal(selected?.place_id, "near");
  assert.ok((selected?.distanceMeters ?? Infinity) < 500);
});

test("selectNearbyPlaceCandidate rejects global and malformed results", () => {
  // Regression test: selectNearbyPlaceCandidate rejects global and malformed results.
  assert.equal(
    selectNearbyPlaceCandidate(
      [
        {
          place_id: "texas",
          name: "FedEx El Paso",
          geometry: { location: { lat: 31.7619, lng: -106.485 } },
        },
      ],
      manhattan
    ),
    null
  );
  assert.equal(
    selectNearbyPlaceCandidate([{ place_id: "missing-location" }], manhattan),
    null
  );
});

test("default place selection rejects results beyond the local boundary", () => {
  // Regression test: default place selection rejects results beyond the local boundary.
  const sixKilometersNorth = {
    place_id: "outside-local-area",
    name: "FedEx outside local area",
    geometry: { location: { lat: 40.812, lng: -73.9855 } },
  };

  assert.equal(
    selectNearbyPlaceCandidate([sixKilometersNorth], manhattan),
    null
  );
});

test("chain lookups pick the nearest branch after merging both searches", () => {
  // Nearby Search returned only a far branch; Text Search found the one at the user.
  const nearby = [
    {
      place_id: "far",
      name: "McDonald's",
      geometry: { location: { lat: 40.7175, lng: -74.0105 } },
    },
  ];
  const text = [
    {
      place_id: "far",
      name: "McDonald's",
      geometry: { location: { lat: 40.7175, lng: -74.0105 } },
    },
    {
      place_id: "here",
      name: "McDonald's",
      formatted_address: "West St, New York",
      geometry: { location: { lat: 40.7148, lng: -74.0138 } },
    },
  ];
  const merged = mergeNearbyPlaceCandidates(nearby, text);
  assert.deepEqual(merged.map(/* Read merged place IDs to verify deduplication without losing closer branches. */ (c) => c.place_id), ["far", "here"]);

  const ranked = selectNearbyPlaceCandidates(
    merged.filter(/* Apply the production relevance filter before checking which merged branch ranks nearest. */ (c) => isNearbyPlaceCandidateRelevant(c, "McDonald's")),
    { lat: 40.71473, lng: -74.01396 }
  );
  assert.equal(ranked[0].place_id, "here");
  assert.ok(ranked[0].distanceMeters < 30);
  assert.match(describeNearbyPlaceCandidates(ranked), /^1\. McDonald's - West St, New York - \d+ m\n2\. McDonald's/);
});

test("permanently closed places are never selected", () => {
  // Regression test: permanently closed places are never selected.
  const selected = selectNearbyPlaceCandidate(
    [
      {
        place_id: "closed",
        name: "FedEx Midtown",
        business_status: "CLOSED_PERMANENTLY",
        geometry: { location: { lat: 40.7581, lng: -73.9855 } },
      },
      {
        place_id: "open",
        name: "FedEx Downtown",
        business_status: "OPERATIONAL",
        geometry: { location: { lat: 40.759, lng: -73.984 } },
      },
    ],
    manhattan
  );
  assert.equal(selected?.place_id, "open");
  assert.equal(describeNearbyPlaceCandidates([]), "NO_RELEVANT_CANDIDATES");
});

test("local place ranking filters distant results before returning options", () => {
  // Regression test: local place ranking filters distant results before returning options.
  const origin = { lat: 40.758, lng: -73.9855 };
  const local = {
    name: "Local store",
    geometry: { location: { lat: 40.759, lng: -73.9855 } },
  };
  const distant = {
    name: "Different-state result",
    geometry: { location: { lat: 41.2, lng: -74.5 } },
  };

  const ranked = selectNearbyPlaceCandidates(
    [distant, local],
    origin,
    MAX_LOCAL_PLACE_DISTANCE_METERS
  );

  assert.deepEqual(ranked.map(/* Read ranked place names to assert distance ordering. */ (place) => place.name), ["Local store"]);
  assert.ok(nearbyPlaceDistanceMeters(origin, origin) < 1);
});

test("editDistance counts insertions, substitutions and adjacent swaps", () => {
  // Regression test: editDistance counts insertions, substitutions and adjacent swaps.
  assert.equal(editDistance("fiterman", "fiterman"), 0);
  assert.equal(editDistance("fitterman", "fiterman"), 1);
  assert.equal(editDistance("sweetgreen", "sweetgren"), 1);
  assert.equal(editDistance("acb", "abc"), 1);
});

test("isNearbyPlaceCandidateRelevant tolerates spacing and small misspellings", () => {
  // Regression test: isNearbyPlaceCandidateRelevant tolerates spacing and small misspellings.
  assert.equal(
    isNearbyPlaceCandidateRelevant({ name: "BMCC Fiterman Hall", types: ["university"] }, "Fitter man hall"),
    true
  );
  assert.equal(isNearbyPlaceCandidateRelevant({ name: "sweetgreen", types: ["restaurant"] }, "sweet green"), true);
  // Short queries never fuzzy-match a different brand.
  assert.equal(isNearbyPlaceCandidateRelevant({ name: "UPS", types: ["store"] }, "CVS"), false);
});

test("isNearbyPlaceCandidateRelevant accepts an acronym of the place name", () => {
  // Regression test: isNearbyPlaceCandidateRelevant accepts an acronym of the place name.
  assert.equal(
    isNearbyPlaceCandidateRelevant(
      { name: "Borough of Manhattan Community College", types: ["university"] },
      "bmcc"
    ),
    true
  );
  assert.equal(
    isNearbyPlaceCandidateRelevant({ name: "Brooklyn Museum", types: ["museum"] }, "bmcc"),
    false
  );
});

test("mergeNearbyPlaceCandidates records every search that returned a place", () => {
  // Regression test: mergeNearbyPlaceCandidates records every search that returned a place.
  const merged = mergeNearbyPlaceCandidates(
    [{ place_id: "a", name: "Target", searchSources: ["nearby"] }],
    [
      { place_id: "a", name: "Target", searchSources: ["text"] },
      { place_id: "b", name: "Target Express", searchSources: ["text"] },
    ]
  );
  assert.deepEqual(merged.map(/* Read merged source tags to verify that deduplication preserves search provenance. */ (c) => c.searchSources), [["nearby", "text"], ["text"]]);
});

test("summarizePlaceCandidates logs kept and rejected results nearest first", () => {
  // Regression test: summarizePlaceCandidates logs kept and rejected results nearest first.
  const summary = summarizePlaceCandidates(
    [
      {
        place_id: "far",
        name: "Shake Shack",
        vicinity: "Herald Square",
        types: ["restaurant", "food", "point_of_interest", "establishment", "extra"],
        searchSources: ["nearby"],
        geometry: { location: { lat: 40.75, lng: -73.988 } },
      },
      {
        place_id: "near",
        name: "Joe's Pizza",
        vicinity: "Broadway",
        searchSources: ["nearby", "text"],
        geometry: { location: { lat: 40.7581, lng: -73.9855 } },
      },
      { place_id: "no-location", name: "Shake Shack" },
    ],
    manhattan,
    "Shake Shack"
  );
  assert.deepEqual(
    summary.map(/* Select candidate identity, relevance, and source fields for concise audit-summary assertions. */ (c) => [c.placeId, c.relevant, c.source]),
    [
      ["near", false, "nearby+text"],
      ["far", true, "nearby"],
    ]
  );
  assert.equal(summary[1].types.length, 4);
  assert.ok(summary[0].distanceMeters < summary[1].distanceMeters);
});

test("signTextMatchesPlaceName confirms only signs that name the destination", () => {
  // Regression test: signTextMatchesPlaceName confirms only signs that name the destination.
  assert.equal(signTextMatchesPlaceName("DUNKIN'\nOPEN 24 HOURS", "Dunkin'"), true);
  assert.equal(signTextMatchesPlaceName("AUNTIE ANNE'S | PRETZELS", "Auntie Anne's"), true);
  assert.equal(signTextMatchesPlaceName("citi\nATM", "Citi"), true);
  // Short names must be whole words, and a generic word cannot stand in.
  assert.equal(signTextMatchesPlaceName("CITIZENS BANK", "Citi"), false);
  assert.equal(signTextMatchesPlaceName("PIZZA", "Frank's Pizza"), false);
  assert.equal(signTextMatchesPlaceName("NO_TEXT", "Subway"), false);
});
