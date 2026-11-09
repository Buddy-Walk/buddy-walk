import assert from "node:assert/strict";
import test from "node:test";
import {
  ambiguousLastMetersBranches, lastMetersNameMatch, rankLastMetersDestinationCandidates,
  splitLastMetersDestinationQuery,
} from "../../server/utils/lastMetersDestinationRanking";
import {
  candidatesAtOtherAddresses,
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
  assert.equal(normalizeNearbyPlaceQuery("closest FedEx near me"), "FedEx");
  assert.equal(normalizeNearbyPlaceQuery("Nearby pharmacy"), "pharmacy");
});

test("extractNearbyPlaceQuery isolates destinations from local requests", () => {
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
  assert.equal(extractNearbyPlaceQuery("FedEx"), null);
  assert.equal(extractNearbyPlaceQuery("FedEx", true), "FedEx");
  assert.equal(extractNearbyPlaceQuery("38 Warren St", true), "38 Warren St");
  assert.equal(extractNearbyPlaceQuery("Hello", true), null);
  assert.equal(extractNearbyPlaceQuery("What is FedEx?", true), null);
});

test("looksLikeBareDestinationQuery detects safe destination-shaped text", () => {
  assert.equal(looksLikeBareDestinationQuery("FedEx"), true);
  assert.equal(looksLikeBareDestinationQuery("Whole Foods"), true);
  assert.equal(looksLikeBareDestinationQuery("38 Warren St"), true);
  assert.equal(looksLikeBareDestinationQuery("Hello"), false);
  assert.equal(looksLikeBareDestinationQuery("What is FedEx?"), false);
});

test("isNearbyPlaceCandidateRelevant rejects fuzzy brand substitutions", () => {
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
  assert.deepEqual(merged.map((c) => c.place_id), ["far", "here"]);

  const ranked = selectNearbyPlaceCandidates(
    merged.filter((c) => isNearbyPlaceCandidateRelevant(c, "McDonald's")),
    { lat: 40.71473, lng: -74.01396 }
  );
  assert.equal(ranked[0].place_id, "here");
  assert.ok(ranked[0].distanceMeters < 30);
  assert.match(describeNearbyPlaceCandidates(ranked), /^1\. McDonald's - West St, New York - \d+ m\n2\. McDonald's/);
});

test("permanently closed places are never selected", () => {
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

  assert.deepEqual(ranked.map((place) => place.name), ["Local store"]);
  assert.ok(nearbyPlaceDistanceMeters(origin, origin) < 1);
});

test("editDistance counts insertions, substitutions and adjacent swaps", () => {
  assert.equal(editDistance("fiterman", "fiterman"), 0);
  assert.equal(editDistance("fitterman", "fiterman"), 1);
  assert.equal(editDistance("sweetgreen", "sweetgren"), 1);
  assert.equal(editDistance("acb", "abc"), 1);
});

test("isNearbyPlaceCandidateRelevant tolerates spacing and small misspellings", () => {
  assert.equal(
    isNearbyPlaceCandidateRelevant({ name: "BMCC Fiterman Hall", types: ["university"] }, "Fitter man hall"),
    true
  );
  assert.equal(isNearbyPlaceCandidateRelevant({ name: "sweetgreen", types: ["restaurant"] }, "sweet green"), true);
  // Short queries never fuzzy-match a different brand.
  assert.equal(isNearbyPlaceCandidateRelevant({ name: "UPS", types: ["store"] }, "CVS"), false);
});

test("isNearbyPlaceCandidateRelevant accepts an acronym of the place name", () => {
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
  const merged = mergeNearbyPlaceCandidates(
    [{ place_id: "a", name: "Target", searchSources: ["nearby"] }],
    [
      { place_id: "a", name: "Target", searchSources: ["text"] },
      { place_id: "b", name: "Target Express", searchSources: ["text"] },
    ]
  );
  assert.deepEqual(merged.map((c) => c.searchSources), [["nearby", "text"], ["text"]]);
});

test("summarizePlaceCandidates logs kept and rejected results nearest first", () => {
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
    summary.map((c) => [c.placeId, c.relevant, c.source]),
    [
      ["near", false, "nearby+text"],
      ["far", true, "nearby"],
    ]
  );
  assert.equal(summary[1].types.length, 4);
  assert.ok(summary[0].distanceMeters < summary[1].distanceMeters);
});

test("signTextMatchesPlaceName confirms only signs that name the destination", () => {
  assert.equal(signTextMatchesPlaceName("DUNKIN'\nOPEN 24 HOURS", "Dunkin'"), true);
  assert.equal(signTextMatchesPlaceName("AUNTIE ANNE'S | PRETZELS", "Auntie Anne's"), true);
  assert.equal(signTextMatchesPlaceName("citi\nATM", "Citi"), true);
  // Short names must be whole words, and a generic word cannot stand in.
  assert.equal(signTextMatchesPlaceName("CITIZENS BANK", "Citi"), false);
  assert.equal(signTextMatchesPlaceName("PIZZA", "Frank's Pizza"), false);
  assert.equal(signTextMatchesPlaceName("NO_TEXT", "Subway"), false);
});

test("candidatesAtOtherAddresses drops listings at the same street address, ignoring case and punctuation", () => {
  const candidate = (placeId: string, address: string) =>
    ({ placeId, name: "Target", address, distanceMeters: 60, types: [], relevant: true, source: "nearby" });
  const candidates = [candidate("grocery", "255 greenwich st., New York"), candidate("soho", "600 Broadway, New York")];
  assert.deepEqual(candidatesAtOtherAddresses(candidates, "255 Greenwich St, New York").map((c) => c.placeId), ["soho"]);
  // Without an address to compare, every candidate may be another branch.
  assert.deepEqual(candidatesAtOtherAddresses(candidates, "").map((c) => c.placeId), ["grocery", "soho"]);
});

const hybridOrigin = { lat: 40.7, lng: -74 };
function hybridPlace(place_id: string, name: string, meters: number, vicinity = "255 Greenwich St", extra: object = {}) {
  return { place_id, name, vicinity, types: ["store"], geometry: { location: { lat: hybridOrigin.lat + meters / 6_371_000 * 180 / Math.PI, lng: hybridOrigin.lng } }, ...extra };
}

test("Last Meters name grades distinguish exact, strong, subsidiary and irrelevant evidence", () => {
  for (const [query, name, category] of [
    ["Target", "Target", "exact"], ["Natura Bissé", "Natura Bisse", "exact"],
    ["Sweet Green", "Sweetgreen", "strong"], ["Target", "Target Inc.", "strong"],
    ["BMCC", "Borough of Manhattan Community College", "strong"],
    ["Target", "Target Mobile", "partial"], ["Fitter man hall", "BMCC Fiterman Hall", "partial"],
  ] as const) assert.deepEqual(lastMetersNameMatch({ name }, query), { category, relevant: true });
  for (const [query, name] of [["Citi", "Citizens Bank"], ["CVS", "UPS"], ["Target", "Other Store"]]) {
    assert.deepEqual(lastMetersNameMatch({ name }, query), { category: "weak", relevant: false });
  }
  assert.deepEqual(lastMetersNameMatch({ name: "CVS", types: ["pharmacy"] }, "pharmacy"), { category: "weak", relevant: true });
});

test("Last Meters exact business wins over nearer subsidiaries without merging their IDs", () => {
  const ranked = rankLastMetersDestinationCandidates([
    hybridPlace("mobile", "Target Mobile", 15), hybridPlace("grocery", "Target Grocery", 18), hybridPlace("main", "Target", 25),
  ], hybridOrigin, "Target");
  assert.deepEqual(ranked.map(candidate => candidate.place_id), ["main", "mobile", "grocery"]);
  assert.equal(rankLastMetersDestinationCandidates(ranked, hybridOrigin, "Target Mobile")[0].place_id, "mobile");
});

test("Last Meters orders comparable names by distance and keeps separate same-address identities", () => {
  const ranked = rankLastMetersDestinationCandidates([hybridPlace("far", "Target", 50), hybridPlace("near", "Target", 25)], hybridOrigin, "Target");
  assert.deepEqual(ranked.map(candidate => candidate.place_id), ["near", "far"]);
});

test("Last Meters parses business addresses and preserves numeric business names", () => {
  assert.deepEqual(splitLastMetersDestinationQuery("Target at 255 Greenwich St"), { name: "Target", address: "255 Greenwich St" });
  assert.deepEqual(splitLastMetersDestinationQuery("Target, 255 Greenwich St"), { name: "Target", address: "255 Greenwich St" });
  assert.deepEqual(splitLastMetersDestinationQuery("38 Warren St"), { name: "", address: "38 Warren St" });
  assert.deepEqual(splitLastMetersDestinationQuery("7-Eleven"), { name: "7-Eleven", address: "" });
  assert.deepEqual(splitLastMetersDestinationQuery("Studio 54"), { name: "Studio 54", address: "" });
});

test("Last Meters explicit address rejects a nearer wrong branch and an unrelated business at the right address", () => {
  const ranked = rankLastMetersDestinationCandidates([
    hybridPlace("wrong", "Target", 10, "600 Broadway"), hybridPlace("unrelated", "Other Store", 5),
    hybridPlace("right", "Target", 60),
  ], hybridOrigin, "Target, 255 Greenwich Street");
  assert.deepEqual(ranked.map(candidate => candidate.place_id), ["right"]);
});

test("Last Meters does not discard an explicit unit number", () => {
  const ranked = rankLastMetersDestinationCandidates([
    hybridPlace("unit1", "Target", 10, "255 Greenwich St Suite 1"),
    hybridPlace("unit2", "Target", 60, "255 Greenwich St #2"),
  ], hybridOrigin, "Target, 255 Greenwich Street Unit 2");
  assert.deepEqual(ranked.map(candidate => candidate.place_id), ["unit2"]);
});

test("Last Meters keeps the 500 m filter local and rejects closed, invalid and missing-ID candidates", () => {
  const outside = hybridPlace("outside", "Target", 501);
  const candidates = [outside, hybridPlace("closed", "Target", 5, undefined, { business_status: "CLOSED_PERMANENTLY" }),
    hybridPlace("invalid", "Target", 1, undefined, { geometry: { location: { lat: 120, lng: -74 } } }),
    hybridPlace("missing", "Target", 2, undefined, { place_id: undefined }),
    hybridPlace("inside", "Target", 499.9)];
  assert.deepEqual(rankLastMetersDestinationCandidates(candidates, hybridOrigin, "Target").map(candidate => candidate.place_id), ["inside"]);
  assert.equal(rankLastMetersDestinationCandidates([outside], hybridOrigin, "Target").length, 0);
  assert.equal(selectNearbyPlaceCandidates([outside], hybridOrigin)[0].place_id, "outside", "public distance selection retains 5 km behavior");
  assert.equal(MAX_LOCAL_PLACE_DISTANCE_METERS, 5000);
});

test("Last Meters ambiguity uses comparable names, explicit address and the existing GPS band", () => {
  const selected = { placeId: "main", placeName: "Target", placeAddress: "255 Greenwich St", distanceMeters: 50, types: ["store"] };
  const log = (placeId: string, name: string, address: string, distanceMeters: number) => ({ placeId, name, address, distanceMeters, types: ["store"], relevant: true, source: "nearby" });
  const candidates = [log("same", "Target", "255 Greenwich Street", 51), log("mobile", "Target Mobile", "600 Broadway", 15), log("other", "Target", "600 Broadway", 80)];
  assert.deepEqual(ambiguousLastMetersBranches(candidates, selected, "Target", 5), []);
  assert.deepEqual(ambiguousLastMetersBranches(candidates, selected, "Target", 40).map(candidate => candidate.placeId), ["other"]);
  assert.deepEqual(ambiguousLastMetersBranches(candidates, selected, "Target, 255 Greenwich St", 40), []);
  assert.deepEqual(ambiguousLastMetersBranches([log("unknown-address", "Target", "", 51)], selected, "Target").map(candidate => candidate.placeId), ["unknown-address"]);
  assert.deepEqual(ambiguousLastMetersBranches([log("outside", "Target", "800 Broadway", 501)], selected, "Target", 1000), []);
});
