export interface NearbyPlaceViewport {
  northeast?: { lat?: number; lng?: number };
  southwest?: { lat?: number; lng?: number };
}

export interface NearbyPlaceCandidate {
  place_id?: string;
  name?: string;
  vicinity?: string;
  formatted_address?: string;
  business_status?: string;
  types?: string[];
  opening_hours?: { open_now?: boolean };
  geometry?: {
    location?: {
      lat?: number;
      lng?: number;
    };
    viewport?: NearbyPlaceViewport;
  };
  /** Which Places searches returned this result ("nearby", "text"). */
  searchSources?: string[];
}

/** One Google Places result as stored on a trial log. */
export interface PlaceCandidateLog {
  placeId?: string;
  name: string;
  address: string;
  distanceMeters: number;
  types: string[];
  relevant: boolean;
  source: string;
  businessStatus?: string;
}

export interface NearbyPlaceSelection extends NearbyPlaceCandidate {
  distanceMeters: number;
}

export const MAX_LOCAL_PLACE_DISTANCE_METERS = 5_000;

/**
 * Compute great-circle distance in meters between two latitude/longitude points using the
 * haversine formula.
 */
export function nearbyPlaceDistanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const earthRadiusMeters = 6_371_000;
  /** Convert degrees to radians for the distance calculation. */
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

const PLACE_TYPE_ALIASES: Record<string, string[]> = {
  atm: ["atm"],
  bank: ["bank"],
  bar: ["bar"],
  cafe: ["cafe"],
  coffee: ["cafe"],
  "coffee shop": ["cafe"],
  gas: ["gas_station"],
  "gas station": ["gas_station"],
  grocery: ["grocery_or_supermarket", "supermarket"],
  "grocery store": ["grocery_or_supermarket", "supermarket"],
  hospital: ["hospital"],
  hotel: ["lodging"],
  pharmacy: ["drugstore", "pharmacy"],
  "post office": ["post_office"],
  restaurant: ["restaurant"],
  supermarket: ["grocery_or_supermarket", "supermarket"],
};

/** Normalize case, apostrophes, punctuation, and whitespace before comparing place names. */
function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Optimal string alignment distance (Levenshtein plus adjacent swaps). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, /* Allocate one edit-distance matrix row with its empty-prefix boundary costs. */ (_, i) =>
    Array.from({ length: cols }, /* Seed the first row and column with insertion/deletion costs; other cells are filled by the recurrence. */ (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Tolerates spacing and small spelling slips ("Fitter man hall" for
 * "Fiterman Hall", "sweet green" for "Sweetgreen"). Short queries must match
 * exactly so "CVS" can never fuzzy-match "UPS".
 */
function fuzzyNameMatch(normalizedQuery: string, normalizedName: string): boolean {
  const query = normalizedQuery.replace(/ /g, "");
  const name = normalizedName.replace(/ /g, "");
  if (query.length < 5 || name.length < 4) return false;
  if (name.includes(query)) return true;
  const allowed = query.length >= 10 ? 2 : 1;
  for (let length = query.length - allowed; length <= query.length + allowed; length++) {
    if (length < 4 || length > name.length) continue;
    for (let start = 0; start + length <= name.length; start++) {
      if (editDistance(query, name.slice(start, start + length)) <= allowed) return true;
    }
  }
  return false;
}

const ACRONYM_STOPWORDS = new Set(["of", "the", "and", "at", "for", "in", "on"]);

/** "bmcc" for "Borough of Manhattan Community College". */
function acronymMatch(normalizedQuery: string, normalizedName: string): boolean {
  if (!/^[a-z]{2,6}$/.test(normalizedQuery)) return false;
  const words = normalizedName.split(" ").filter(Boolean);
  if (words.length < 2) return false;
  /** Build an acronym from the first letter of each retained name word. */
  const initials = (list: string[]) => list.map(/* Read a name word's first character for acronym matching. */ (word) => word[0]).join("");
  return (
    initials(words.filter(/* Ignore common connector words when comparing a place name to its acronym. */ (word) => !ACRONYM_STOPWORDS.has(word))) === normalizedQuery ||
    initials(words) === normalizedQuery
  );
}

/**
 * Match a candidate to the destination using normalized names, token coverage, place-type aliases,
 * conservative fuzzy/acronym matches, and address numbers.
 */
export function isNearbyPlaceCandidateRelevant(
  candidate: NearbyPlaceCandidate,
  query: string
): boolean {
  const normalizedQuery = normalizeMatchText(normalizeNearbyPlaceQuery(query));
  if (!normalizedQuery) return false;

  const normalizedName = normalizeMatchText(candidate.name || "");
  const normalizedAddress = normalizeMatchText(candidate.vicinity || "");
  if (
    normalizedName.includes(normalizedQuery) ||
    normalizedQuery.includes(normalizedName) && normalizedName.length >= 4
  ) {
    return true;
  }

  const queryTokens = normalizedQuery.split(" ").filter(/* Ignore one-character tokens that would make unrelated names appear relevant. */ (token) => token.length >= 2);
  const nameTokens = new Set(normalizedName.split(" "));
  if (queryTokens.length > 0 && queryTokens.every(/* Require every meaningful query token to occur in the candidate name. */ (token) => nameTokens.has(token))) {
    return true;
  }

  const aliases = PLACE_TYPE_ALIASES[normalizedQuery] ?? [];
  if (aliases.some(/* Match a generic destination category against Google place types. */ (type) => candidate.types?.includes(type))) {
    return true;
  }

  if (
    fuzzyNameMatch(normalizedQuery, normalizedName) ||
    acronymMatch(normalizedQuery, normalizedName)
  ) {
    return true;
  }

  const queryNumbers = queryTokens.filter(/* Extract numeric query tokens for street-number matching. */ (token) => /^\d+$/.test(token));
  return (
    queryNumbers.length > 0 &&
    queryNumbers.every(/* Require each requested address number to occur as a complete address token. */ (number) => normalizedAddress.split(" ").includes(number))
  );
}

/**
 * Whether text read off a storefront names the destination. Names under five
 * letters must appear as whole words so "Citi" never matches "Citizens Bank".
 */
export function signTextMatchesPlaceName(signText: string, placeName: string): boolean {
  const name = normalizeMatchText(placeName);
  if (!name) return false;
  const compactName = name.replace(/ /g, "");
  return signText.split(/[\n|]+/).some((line) => {
    // Compare one visible sign line to the candidate name, requiring substantial name coverage
    // instead of accepting generic sign fragments.
    const text = normalizeMatchText(line);
    if (!text) return false;
    if (compactName.length < 5) {
      return ` ${text} `.includes(` ${name} `);
    }
    const compactText = text.replace(/ /g, "");
    // A sign fragment may only stand in for the name when it covers most of
    // it, so a generic "PIZZA" sign cannot confirm "Frank's Pizza".
    return (
      compactText.includes(compactName) ||
      fuzzyNameMatch(name, text) ||
      (compactText.length >= compactName.length * 0.75 && fuzzyNameMatch(text, name))
    );
  });
}

/** Remove proximity words from a destination query while retaining the actual place name. */
export function normalizeNearbyPlaceQuery(query: string): string {
  return query
    .replace(/\b(?:closest|nearest)\b/gi, "")
    .replace(/\b(?:near|close to)\s+me\b/gi, "")
    .replace(/\bnearby\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Recognize short standalone destination names or addresses without routing ordinary
 * conversational questions into place search.
 */
export function looksLikeBareDestinationQuery(input: string): boolean {
  const text = input.trim();
  if (!text || text.length > 120 || /[?!]/.test(text)) return false;
  if (
    /^(?:hi|hello|thanks|thank you|what|who|why|how|when|is|are|can|could|would|should|tell|describe|explain)\b/i.test(
      text
    )
  ) {
    return false;
  }

  const words = text.split(/\s+/);
  if (words.length > 8) return false;

  return (
    /\d/.test(text) ||
    /\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|place|pl|plaza|square|park|station|terminal|store|market|pharmacy|bank|restaurant|cafe|coffee|library|hospital|hotel)\b/i.test(
      text
    ) ||
    /^[A-Z][\w'&.-]*(?:\s+[A-Z0-9][\w'&.-]*){0,5}$/.test(text)
  );
}

/**
 * Extract a destination from navigation/proximity wording, optionally allowing a conservative
 * standalone name or address.
 */
export function extractNearbyPlaceQuery(
  input: string,
  allowBareDestination = false
): string | null {
  const text = input.trim();
  const patterns = [
    /(?:directions?|route|navigate|walk|head|take me|get me|bring me)\s+(?:to|toward|towards)\s+(.+)/i,
    /how\s+(?:do|can|would|could)\s+i\s+(?:get|walk|go)\s+(?:to|toward|towards)\s+(.+)/i,
    /(?:nearest|closest)\s+(.+?)(?:\s+(?:to|from)\s+me)?[?.!]*$/i,
    /(?:find|show me|where(?:'s| is))\s+(?:the\s+)?(.+?)(?:\s+(?:near|close to)\s+me|\s+nearby)?[?.!]*$/i,
    /(.+?)\s+(?:near|close to)\s+me[?.!]*$/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const query = normalizeNearbyPlaceQuery(
      match[1].replace(/[?.!]+\s*$/, "").replace(/^(?:the|a|an)\s+/i, "")
    );
    if (/^(?:what|which|who|how|is|are)\b/i.test(query)) continue;
    if (query.length >= 2) return query;
  }

  if (allowBareDestination) {
    const query = normalizeNearbyPlaceQuery(
      text.replace(/[.!]+\s*$/, "").replace(/^(?:the|a|an)\s+/i, "")
    );
    if (
      query.length >= 2 &&
      query.length <= 120 &&
      looksLikeBareDestinationQuery(text)
    ) {
      return query;
    }
  }

  return null;
}

/**
 * Return the nearest eligible local candidate, or null when none passes location and status
 * filtering.
 */
export function selectNearbyPlaceCandidate(
  candidates: NearbyPlaceCandidate[],
  origin: { lat: number; lng: number },
  maxDistanceMeters = MAX_LOCAL_PLACE_DISTANCE_METERS
): NearbyPlaceSelection | null {
  return selectNearbyPlaceCandidates(candidates, origin, maxDistanceMeters)[0] ?? null;
}

/**
 * Measure and rank candidates after discarding invalid coordinates, permanently closed businesses,
 * and places outside the configured radius.
 */
export function selectNearbyPlaceCandidates(
  candidates: NearbyPlaceCandidate[],
  origin: { lat: number; lng: number },
  maxDistanceMeters = MAX_LOCAL_PLACE_DISTANCE_METERS
): NearbyPlaceSelection[] {
  return candidates
    .map((candidate) => {
      // Attach a geodesic distance only when the candidate supplies finite numeric coordinates.
      const lat = candidate.geometry?.location?.lat;
      const lng = candidate.geometry?.location?.lng;
      if (
        typeof lat !== "number" ||
        !Number.isFinite(lat) ||
        typeof lng !== "number" ||
        !Number.isFinite(lng)
      ) {
        return null;
      }
      return {
        ...candidate,
        distanceMeters: nearbyPlaceDistanceMeters(origin, { lat, lng }),
      };
    })
    .filter(/* Remove candidates whose coordinates could not be measured. */ (candidate): candidate is NearbyPlaceSelection => candidate !== null)
    .filter(/* Exclude businesses explicitly marked permanently closed. */ (candidate) => candidate.business_status !== "CLOSED_PERMANENTLY")
    .filter(/* Keep candidates inside the caller's maximum local search distance. */ (candidate) => candidate.distanceMeters <= maxDistanceMeters)
    .sort(/* Order eligible places from nearest to farthest. */ (a, b) => a.distanceMeters - b.distanceMeters);
}

/**
 * Combines Nearby Search and Text Search results, keeping the first copy of
 * each place and the union of the searches that returned it.
 */
export function mergeNearbyPlaceCandidates(
  ...groups: NearbyPlaceCandidate[][]
): NearbyPlaceCandidate[] {
  const seen = new Map<string, NearbyPlaceCandidate>();
  const merged: NearbyPlaceCandidate[] = [];
  for (const candidate of groups.flat()) {
    const key = candidate.place_id;
    const existing = key ? seen.get(key) : undefined;
    if (existing) {
      const sources = new Set([
        ...(existing.searchSources ?? []),
        ...(candidate.searchSources ?? []),
      ]);
      existing.searchSources = [...sources];
      continue;
    }
    const copy = { ...candidate };
    if (key) seen.set(key, copy);
    merged.push(copy);
  }
  return merged;
}

/** Every returned place (kept or rejected), nearest first, for the trial log. */
export function summarizePlaceCandidates(
  candidates: NearbyPlaceCandidate[],
  origin: { lat: number; lng: number },
  query: string,
  limit = 8
): PlaceCandidateLog[] {
  return candidates
    .map((candidate): PlaceCandidateLog | null => {
      // Build a compact candidate audit record with distance, relevance, source, and business
      // status.
      const lat = candidate.geometry?.location?.lat;
      const lng = candidate.geometry?.location?.lng;
      if (typeof lat !== "number" || typeof lng !== "number") return null;
      return {
        placeId: candidate.place_id,
        name: candidate.name ?? "Unnamed",
        address: candidate.vicinity ?? candidate.formatted_address ?? "",
        distanceMeters: Math.round(nearbyPlaceDistanceMeters(origin, { lat, lng })),
        types: (candidate.types ?? []).slice(0, 4),
        relevant: isNearbyPlaceCandidateRelevant(candidate, query),
        source: (candidate.searchSources ?? []).join("+") || "unknown",
        businessStatus: candidate.business_status,
      };
    })
    .filter(/* Remove audit candidates lacking coordinate data. */ (candidate): candidate is PlaceCandidateLog => candidate !== null)
    .sort(/* List candidate audit records in increasing distance order. */ (a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit);
}

/**
 * Describe a bounded set of candidate names, addresses, and distances for the AI prompt, marking
 * an empty result explicitly.
 */
export function describeNearbyPlaceCandidates(
  candidates: NearbyPlaceSelection[],
  limit = 5
): string {
  if (candidates.length === 0) return "NO_RELEVANT_CANDIDATES";
  return candidates
    .slice(0, limit)
    .map(
      /** Format one numbered candidate with its address fallback and rounded distance. */
      (candidate, index) =>
        `${index + 1}. ${candidate.name ?? "Unnamed"} - ` +
        `${candidate.vicinity ?? candidate.formatted_address ?? "no address"} - ` +
        `${Math.round(candidate.distanceMeters)} m`
    )
    .join("\n");
}
