import assert from "node:assert/strict";
import test from "node:test";
import {
  distanceToOutlineMeters,
  isBesideBuilding,
  parseBuildingGeometry,
  selectNearestEntrance,
  usesBuildingEntrances,
} from "../../server/utils/buildingEntrances";

// A roughly 110 m by 110 m block around Brookfield Place.
const outline = [
  { lat: 40.7125, lng: -74.0165 },
  { lat: 40.7125, lng: -74.0152 },
  { lat: 40.7135, lng: -74.0152 },
  { lat: 40.7135, lng: -74.0165 },
];

const geocodeResult = {
  buildings: [
    {
      place_id: "building-1",
      building_outlines: [
        {
          display_polygon: {
            type: "Polygon",
            coordinates: [[...outline, outline[0]].map(/* Encode the closed building-outline fixture in GeoJSON longitude/latitude order. */ (p) => [p.lng, p.lat])],
          },
        },
      ],
    },
  ],
  entrances: [
    { location: { lat: 40.7135, lng: -74.0158 }, entrance_tags: [], building_place_id: "building-1" },
    { location: { lat: 40.7125, lng: -74.0158 }, entrance_tags: ["PREFERRED"], building_place_id: "building-1" },
    { location: { latitude: 40.713, longitude: -74.0165 } },
    { location: { lat: "bad" } },
  ],
};

test("parseBuildingGeometry reads entrances, outlines and building ids", () => {
  // Regression test: parseBuildingGeometry reads entrances, outlines and building ids.
  const geometry = parseBuildingGeometry(geocodeResult);
  assert.equal(geometry.entrances.length, 3);
  assert.deepEqual(geometry.entrances[1].tags, ["PREFERRED"]);
  assert.equal(geometry.entrances[0].buildingPlaceId, "building-1");
  assert.equal(geometry.outlines.length, 1);
  assert.equal(geometry.outlines[0].length, 5);
  assert.deepEqual(geometry.buildingPlaceIds, ["building-1"]);
  assert.deepEqual(parseBuildingGeometry(undefined), { entrances: [], outlines: [], buildingPlaceIds: [] });
});

test("selectNearestEntrance picks the door nearest the user", () => {
  // Regression test: selectNearestEntrance picks the door nearest the user.
  const { entrances } = parseBuildingGeometry(geocodeResult);
  const northSide = { lat: 40.7137, lng: -74.0158 };
  const nearest = selectNearestEntrance(northSide, entrances);
  assert.ok(nearest);
  assert.equal(nearest.entrance.location.lat, 40.7135);
  assert.ok(nearest.distanceMeters < 30);
  assert.equal(selectNearestEntrance(northSide, []), null);
});

test("selectNearestEntrance prefers a PREFERRED door within 10 meters of the nearest", () => {
  // Regression test: selectNearestEntrance prefers a PREFERRED door within 10 meters of the
  // nearest.
  const entrances = [
    { location: { lat: 40.7130, lng: -74.0158 }, tags: [] },
    { location: { lat: 40.71305, lng: -74.0158 }, tags: ["PREFERRED"] },
  ];
  const nearest = selectNearestEntrance({ lat: 40.7129, lng: -74.0158 }, entrances);
  assert.deepEqual(nearest?.entrance.tags, ["PREFERRED"]);
});

test("distanceToOutlineMeters is zero inside and measures to the nearest wall outside", () => {
  // Regression test: distanceToOutlineMeters is zero inside and measures to the nearest wall
  // outside.
  assert.equal(distanceToOutlineMeters({ lat: 40.713, lng: -74.0158 }, outline), 0);
  const outside = distanceToOutlineMeters({ lat: 40.7138, lng: -74.0158 }, outline);
  assert.ok(outside > 30 && outside < 36, `expected about 33 m, got ${outside}`);
});

test("isBesideBuilding widens with GPS error but stays capped", () => {
  // Regression test: isBesideBuilding widens with GPS error but stays capped.
  const acrossTheStreet = { lat: 40.7138, lng: -74.0158 };
  assert.equal(isBesideBuilding(acrossTheStreet, [outline], 5), false);
  assert.equal(isBesideBuilding(acrossTheStreet, [outline], 35), true);
  assert.equal(isBesideBuilding({ lat: 40.7145, lng: -74.0158 }, [outline], 500), false);
  assert.equal(isBesideBuilding(acrossTheStreet, [], 35), false);
});

test("usesBuildingEntrances only applies to the building itself or large venues", () => {
  // Regression test: usesBuildingEntrances only applies to the building itself or large venues.
  const geometry = parseBuildingGeometry(geocodeResult);
  assert.equal(usesBuildingEntrances("building-1", ["establishment"], geometry), true);
  assert.equal(usesBuildingEntrances("shop-1", ["shopping_mall", "establishment"], geometry), true);
  assert.equal(usesBuildingEntrances("shop-2", ["cafe", "food"], geometry), false);
});
