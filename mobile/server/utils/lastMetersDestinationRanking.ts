import {
  candidatesAtOtherAddresses,
  editDistance,
  isNearbyPlaceCandidateRelevant,
  mergeNearbyPlaceCandidates,
  normalizeNearbyPlaceQuery,
  selectNearbyPlaceCandidates,
  type NearbyPlaceCandidate,
  type NearbyPlaceSelection,
  type PlaceCandidateLog,
} from "./nearbyPlaces";

/** Last Meters eligibility only; other navigation retains its existing limits. */
export const LAST_METERS_DESTINATION_RADIUS_METERS = 500;
export type DestinationNameMatch = "exact" | "strong" | "partial" | "weak";
const NAME_ORDER: Record<DestinationNameMatch, number> = { exact: 0, strong: 1, partial: 2, weak: 3 };
const ADDRESS_WORDS: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", boulevard: "blvd", drive: "dr",
  lane: "ln", court: "ct", place: "pl", parkway: "pkwy", suite: "unit", ste: "unit", apartment: "unit", apt: "unit",
};
const CORPORATE_WORDS = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corporation", "corp"]);
const ACRONYM_STOPWORDS = new Set(["of", "the", "and", "at", "for", "in", "on"]);

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function addressKey(value: string): string {
  return normalize(value.replace(/#/g, " unit ")).split(" ").map(word => ADDRESS_WORDS[word] ?? word).join(" ");
}
export function splitLastMetersDestinationQuery(query: string): { name: string; address: string } {
  const text = normalizeNearbyPlaceQuery(query);
  // Bare street addresses remain usable; numbers in business names alone are not addresses.
  if (/^\d+[a-z-]*\s+.*\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|place|pl|parkway|pkwy)\b/i.test(text)) {
    return { name: "", address: text };
  }
  const comma = text.indexOf(",");
  if (comma >= 0) return { name: text.slice(0, comma).trim(), address: text.slice(comma + 1).trim() };
  const address = text.match(/^(.+?)\s+(?:at\s+)?(\d+[a-z-]*\s+.+)$/i);
  return address ? { name: address[1].trim(), address: address[2].trim() } : { name: text, address: "" };
}

/** Word boundaries prevent a short brand such as Citi from matching Citizens. */
export function lastMetersNameMatch(candidate: Pick<NearbyPlaceCandidate, "name" | "types">, query: string): { category: DestinationNameMatch; relevant: boolean } {
  const wanted = normalize(query);
  const name = normalize(candidate.name || "");
  if (!wanted) return { category: "weak", relevant: false };
  if (name === wanted) return { category: "exact", relevant: true };
  const wantedWords = wanted.split(" ");
  const nameWords = name.split(" ").filter(Boolean);
  const core = (words: string[]) => words.filter(word => !CORPORATE_WORDS.has(word));
  const wantedCore = core(wantedWords), nameCore = core(nameWords);
  const compact = wantedCore.join(""), compactName = nameCore.join("");
  const allowedEdits = compact.length >= 10 ? 2 : 1;
  const acronym = (words: string[]) => words.filter(word => !ACRONYM_STOPWORDS.has(word)).map(word => word[0]).join("");
  if (name && (compact === compactName
    || [...wantedCore].sort().join(" ") === [...nameCore].sort().join(" ")
    || (/^[a-z]{2,6}$/.test(wanted) && nameWords.length > 1 && (acronym(nameWords) === wanted || nameWords.map(word => word[0]).join("") === wanted))
    || (compact.length >= 5 && compactName.length >= 4 && Math.abs(compact.length - compactName.length) <= allowedEdits && editDistance(compact, compactName) <= allowedEdits))) {
    return { category: "strong", relevant: true };
  }
  const contains = (a: string, b: string) => !!b && ` ${a} `.includes(` ${b} `);
  if (name && (contains(name, wanted) || contains(wanted, name)
    || wantedWords.every(word => nameWords.includes(word)))) return { category: "partial", relevant: true };
  // Preserve existing spacing/typo tolerance, but compare whole word spans rather than arbitrary substrings.
  if (compact.length >= 5) {
    for (let start = 0; start < nameWords.length; start++) {
      let span = "";
      for (let end = start; end < nameWords.length; end++) {
        span += nameWords[end];
        if (span.length > compact.length + allowedEdits) break;
        if (Math.abs(span.length - compact.length) <= allowedEdits && editDistance(compact, span) <= allowedEdits) {
          return { category: "partial", relevant: true };
        }
      }
    }
  }
  // Generic category requests such as "pharmacy" still use the existing type aliases.
  return { category: "weak", relevant: isNearbyPlaceCandidateRelevant({ name: "", types: candidate.types }, query) };
}

export function lastMetersAddressMatches(candidate: Pick<NearbyPlaceCandidate, "vicinity" | "formatted_address">, explicitAddress: string): boolean {
  if (!explicitAddress) return true;
  const expected = addressKey(explicitAddress);
  return !!expected && [candidate.vicinity, candidate.formatted_address].some(address => {
    const actual = addressKey(address || "");
    return actual === expected || actual.startsWith(`${expected} `);
  });
}

export function hasValidLastMetersPlaceCoordinates(candidate: NearbyPlaceCandidate): boolean {
  const point = candidate.geometry?.location;
  return typeof point?.lat === "number" && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && typeof point.lng === "number" && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

/** Pure opt-in ranking; Google retrieval and the shared distance selector are unchanged. */
export function rankLastMetersDestinationCandidates(candidates: NearbyPlaceCandidate[], origin: { lat: number; lng: number }, query: string): NearbyPlaceSelection[] {
  const parts = splitLastMetersDestinationQuery(query);
  return selectNearbyPlaceCandidates(mergeNearbyPlaceCandidates(candidates).filter(candidate =>
    !!candidate.place_id && hasValidLastMetersPlaceCoordinates(candidate) && lastMetersAddressMatches(candidate, parts.address)
    && (parts.name ? lastMetersNameMatch(candidate, parts.name).relevant : !!parts.address)), origin, LAST_METERS_DESTINATION_RADIUS_METERS)
    .sort((a, b) => NAME_ORDER[lastMetersNameMatch(a, parts.name).category] - NAME_ORDER[lastMetersNameMatch(b, parts.name).category]
      || a.distanceMeters - b.distanceMeters || a.place_id!.localeCompare(b.place_id!, "en"));
}

/** Only equally strong, eligible different-address candidates can create branch ambiguity. */
export function ambiguousLastMetersBranches(
  candidates: PlaceCandidateLog[],
  selected: { placeId: string; placeName: string; placeAddress: string; distanceMeters: number; types: string[] },
  query: string,
  gpsAccuracyMeters?: number,
): PlaceCandidateLog[] {
  const parts = splitLastMetersDestinationQuery(query);
  const selectedGrade = lastMetersNameMatch({ name: selected.placeName, types: selected.types }, parts.name).category;
  const accuracy = typeof gpsAccuracyMeters === "number" && Number.isFinite(gpsAccuracyMeters) && gpsAccuracyMeters >= 0 ? gpsAccuracyMeters : 20;
  // Canonicalize here rather than changing the public same-address helper for all callers.
  const atOtherAddresses = candidatesAtOtherAddresses(candidates.map(row => ({ ...row, address: addressKey(row.address) })), addressKey(selected.placeAddress));
  const otherIds = new Set(atOtherAddresses.map(row => row.placeId));
  return candidates.filter(candidate => {
    const match = lastMetersNameMatch({ name: candidate.name, types: candidate.types }, parts.name);
    return otherIds.has(candidate.placeId) && !!candidate.placeId && candidate.placeId !== selected.placeId && candidate.relevant
      && candidate.businessStatus !== "CLOSED_PERMANENTLY" && (parts.name ? match.relevant && match.category === selectedGrade : true)
      && lastMetersAddressMatches({ vicinity: candidate.address }, parts.address)
      && candidate.distanceMeters <= LAST_METERS_DESTINATION_RADIUS_METERS
      && candidate.distanceMeters <= selected.distanceMeters + Math.max(20, accuracy);
  });
}
