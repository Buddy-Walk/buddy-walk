import { nearbyPlaceDistanceMeters } from "./nearbyPlaces";

/**
 * Parses Google Geocoding "building and entrances" data (requested with
 * extra_computations=BUILDING_AND_ENTRANCES) so a large building is reached
 * through the entrance nearest the user instead of its single map pin.
 */
export interface LatLngPoint {
  lat: number;
  lng: number;
}

export interface BuildingEntrance {
  location: LatLngPoint;
  tags: string[];
  buildingPlaceId?: string;
}

export interface BuildingGeometry {
  entrances: BuildingEntrance[];
  /** Outer rings, each a closed list of points. */
  outlines: LatLngPoint[][];
  buildingPlaceIds: string[];
}

/**
 * Venues large enough to have several public doors. For anything else (a
 * coffee shop inside an office tower) the building's entrances may be lobby
 * doors that do not lead to the destination at all.
 */
const MULTI_ENTRANCE_PLACE_TYPES = new Set([
  "airport",
  "city_hall",
  "courthouse",
  "department_store",
  "hospital",
  "library",
  "local_government_office",
  "museum",
  "primary_school",
  "school",
  "secondary_school",
  "shopping_mall",
  "stadium",
  "subway_station",
  "train_station",
  "transit_station",
  "university",
]);

/** True when the place is itself the building (or a venue that spans one). */
export function usesBuildingEntrances(
  placeId: string,
  placeTypes: string[],
  geometry: BuildingGeometry
): boolean {
  return (
    geometry.buildingPlaceIds.includes(placeId) ||
    placeTypes.some(/* Recognize venue types whose public doors can reasonably represent the destination building. */ (type) => MULTI_ENTRANCE_PLACE_TYPES.has(type))
  );
}

/** Normalize either supported coordinate-field spelling into a finite latitude/longitude pair. */
function toPoint(value: any): LatLngPoint | null {
  const lat = value?.lat ?? value?.latitude;
  const lng = value?.lng ?? value?.longitude;
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng }
    : null;
}

/**
 * Extract usable exterior rings from Polygon or MultiPolygon geometry, ignoring unsupported or
 * degenerate shapes.
 */
function ringsFromGeoJson(geometry: any): LatLngPoint[][] {
  /**
   * Convert one GeoJSON longitude/latitude ring into the internal point format and discard invalid
   * pairs.
   */
  const toRing = (ring: unknown): LatLngPoint[] =>
    Array.isArray(ring)
      ? ring
          .map(/* Reverse a valid GeoJSON coordinate pair into latitude/longitude order. */ (pair) =>
            Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number"
              ? { lat: pair[1], lng: pair[0] }
              : null
          )
          .filter(/* Remove coordinates that could not be parsed from the ring. */ (point): point is LatLngPoint => point !== null)
      : [];
  if (geometry?.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    return [toRing(geometry.coordinates[0])].filter(/* Keep only polygon rings with enough points to enclose an area. */ (ring) => ring.length >= 3);
  }
  if (geometry?.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates
      .map(/* Read the outer ring of each polygon rather than treating interior holes as building boundaries. */ (polygon: unknown[]) => toRing(polygon?.[0]))
      .filter(/* Drop degenerate outer rings from the MultiPolygon result. */ (ring: LatLngPoint[]) => ring.length >= 3);
  }
  return [];
}

/**
 * Normalize Google building/entrance enrichment into valid doors, exterior outlines, and building
 * place IDs.
 */
export function parseBuildingGeometry(geocodeResult: any): BuildingGeometry {
  const entrances: BuildingEntrance[] = (Array.isArray(geocodeResult?.entrances) ? geocodeResult.entrances : [])
    .map((entrance: any) => {
      // Keep an entrance only when its location is usable, carrying its preference tags and
      // building identity.
      const location = toPoint(entrance?.location);
      return location
        ? {
            location,
            tags: Array.isArray(entrance?.entrance_tags) ? entrance.entrance_tags.map(String) : [],
            buildingPlaceId:
              typeof entrance?.building_place_id === "string" ? entrance.building_place_id : undefined,
          }
        : null;
    })
    .filter(/* Remove entrance entries whose locations could not be normalized. */ (entrance: BuildingEntrance | null): entrance is BuildingEntrance => entrance !== null);

  const outlines: LatLngPoint[][] = [];
  const buildingPlaceIds: string[] = [];
  for (const building of Array.isArray(geocodeResult?.buildings) ? geocodeResult.buildings : []) {
    if (typeof building?.place_id === "string") buildingPlaceIds.push(building.place_id);
    for (const outline of Array.isArray(building?.building_outlines) ? building.building_outlines : []) {
      outlines.push(...ringsFromGeoJson(outline?.display_polygon));
    }
  }
  return { entrances, outlines, buildingPlaceIds };
}

/** Nearest entrance; a "PREFERRED" one wins ties within 10 meters. */
export function selectNearestEntrance(
  user: LatLngPoint,
  entrances: BuildingEntrance[]
): { entrance: BuildingEntrance; distanceMeters: number } | null {
  const ranked = entrances
    .map(/* Attach the user-to-door distance used to rank public entrances. */ (entrance) => ({ entrance, distanceMeters: nearbyPlaceDistanceMeters(user, entrance.location) }))
    .sort(/* Rank entrance candidates from nearest to farthest. */ (a, b) => a.distanceMeters - b.distanceMeters);
  if (ranked.length === 0) return null;
  const preferred = ranked.find(
    /** Prefer a tagged entrance only when it is within ten meters of the nearest door. */
    (item) => item.entrance.tags.includes("PREFERRED") && item.distanceMeters - ranked[0].distanceMeters <= 10
  );
  return preferred ?? ranked[0];
}

/** Local flat projection in meters around `origin`; accurate at building scale. */
function project(origin: LatLngPoint, point: LatLngPoint): { x: number; y: number } {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLng = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  return {
    x: (point.lng - origin.lng) * metersPerDegreeLng,
    y: (point.lat - origin.lat) * metersPerDegreeLat,
  };
}

/** 0 when the user is inside the outline, otherwise meters to its nearest edge. */
export function distanceToOutlineMeters(user: LatLngPoint, outline: LatLngPoint[]): number {
  if (outline.length < 3) return Infinity;
  const points = outline.map(/* Project each boundary point into local meters around the user for the point-in-polygon and edge-distance calculations. */ (point) => project(user, point));
  let inside = false;
  let nearest = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a.y > 0 !== b.y > 0 && 0 < ((b.x - a.x) * (0 - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));
    nearest = Math.min(nearest, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return inside ? 0 : nearest;
}

/**
 * Whether the user is standing at the building itself. The allowance grows
 * with GPS error but is capped so a user across a wide avenue does not count.
 */
export function isBesideBuilding(
  user: LatLngPoint,
  outlines: LatLngPoint[][],
  gpsAccuracyMeters?: number
): boolean {
  if (outlines.length === 0) return false;
  const allowance = Math.min(
    40,
    Math.max(20, typeof gpsAccuracyMeters === "number" && Number.isFinite(gpsAccuracyMeters) ? gpsAccuracyMeters : 0)
  );
  return outlines.some(/* Accept proximity to any valid building outline within the bounded GPS allowance. */ (outline) => distanceToOutlineMeters(user, outline) <= allowance);
}
