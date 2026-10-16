import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@buddywalk:savedPlaces:v1';

export interface SavedPlace {
  id: string;
  alias: string;
  address: string;
  lat?: number;
  lon?: number;
  createdAt: string;
}

export interface SavePlaceInput {
  alias: string;
  address: string;
  lat?: number;
  lon?: number;
}

export interface ExpansionResult {
  text: string;
  matched: SavedPlace[];
}

export interface SavedPlacesStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

interface SavedPlacesStoreOptions {
  storage: SavedPlacesStorage;
  now?: () => Date;
  random?: () => number;
  warn?: (...args: unknown[]) => void;
}

/** Normalize saved-place aliases for case-insensitive lookup and duplicate detection. */
function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

/** Escape a user-created alias before including it in a regular expression. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create a saved-place repository with injected storage, clock, randomness, and logging so
 * persistence and alias expansion can be tested independently of the device.
 */
export function createSavedPlacesStore({
  storage,
  now = /* Use the current wall-clock time unless the caller supplies a deterministic clock for testing. */ () => new Date(),
  random = Math.random,
  warn = console.warn,
}: SavedPlacesStoreOptions) {
  /** Create a local saved-place identifier using the repository's injected clock and random source. */
  function genId(): string {
    return now().getTime().toString(36) + random().toString(36).slice(2, 8);
  }

  /**
   * Read valid saved-place records from storage, returning an empty list for missing or malformed
   * data.
   */
  async function listSavedPlaces(): Promise<SavedPlace[]> {
    try {
      const raw = await storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        /**
         * Discard persisted entries that lack the required saved-place ID, alias, or address
         * fields.
         */
        (p): p is SavedPlace =>
          !!p &&
          typeof p.id === 'string' &&
          typeof p.alias === 'string' &&
          typeof p.address === 'string'
      );
    } catch (e) {
      warn('listSavedPlaces: bad storage payload', e);
      return [];
    }
  }

  /** Persist the complete saved-place collection in the shared storage entry. */
  async function writePlaces(places: SavedPlace[]): Promise<void> {
    await storage.setItem(STORAGE_KEY, JSON.stringify(places));
  }

  /** Find a saved destination by normalized alias and return null when no usable alias matches. */
  async function findPlaceByAlias(alias: string): Promise<SavedPlace | null> {
    const target = normalizeAlias(alias);
    if (!target) return null;
    const all = await listSavedPlaces();
    return all.find(/* Match this saved place against the caller's normalized alias. */ (p) => normalizeAlias(p.alias) === target) ?? null;
  }

  /**
   * Validate and save a destination, updating an existing normalized alias rather than creating a
   * duplicate.
   */
  async function savePlace(input: SavePlaceInput): Promise<SavedPlace> {
    const alias = input.alias.trim();
    const address = input.address.trim();
    if (!alias) throw new Error('Alias is required');
    if (!address) throw new Error('Address is required');

    const existing = await listSavedPlaces();
    const conflicting = existing.find(/* Find an alias collision before deciding whether the saved destination should be inserted or replaced. */ (p) => normalizeAlias(p.alias) === normalizeAlias(alias));
    const updated: SavedPlace = conflicting
      ? { ...conflicting, alias, address, lat: input.lat, lon: input.lon }
      : {
          id: genId(),
          alias,
          address,
          lat: input.lat,
          lon: input.lon,
          createdAt: now().toISOString(),
        };

    const next = conflicting
      ? existing.map(/* Replace only the matching saved record and preserve every other destination. */ (p) => (p.id === conflicting.id ? updated : p))
      : [...existing, updated];

    await writePlaces(next);
    return updated;
  }

  /** Delete the saved record with the specified ID and persist the remaining collection. */
  async function deletePlace(id: string): Promise<void> {
    const all = await listSavedPlaces();
    await writePlaces(all.filter(/* Keep saved destinations other than the one being deleted. */ (p) => p.id !== id));
  }

  /**
   * Expand whole-word saved aliases into their address/coordinate representation, preferring
   * longer aliases and recording which destinations matched.
   */
  async function expandSavedAliases(text: string): Promise<ExpansionResult> {
    const trimmed = text.trim();
    if (!trimmed) return { text: trimmed, matched: [] };
    const all = await listSavedPlaces();
    if (all.length === 0) return { text: trimmed, matched: [] };

    const sorted = [...all].sort(/* Process longer aliases first so a short alias does not consume part of a more specific saved name. */ (a, b) => b.alias.length - a.alias.length);
    const matched: SavedPlace[] = [];
    let result = trimmed;

    for (const place of sorted) {
      const aliasPattern = escapeRegex(place.alias.trim());
      if (!aliasPattern) continue;
      const re = new RegExp(`(^|[^A-Za-z0-9_])(${aliasPattern})(?=$|[^A-Za-z0-9_])`, 'gi');
      let didMatch = false;
      const replacement =
        place.lat != null && place.lon != null
          ? `${place.address} (coordinates ${place.lat}, ${place.lon})`
          : place.address;
      result = result.replace(re, (_fullMatch, prefix: string) => {
        // Substitute the saved destination while preserving the separator that preceded its
        // alias.
        didMatch = true;
        return `${prefix}${replacement}`;
      });
      if (didMatch) {
        matched.push(place);
      }
    }

    return { text: result.replace(/\s+/g, ' ').trim(), matched };
  }

  return {
    listSavedPlaces,
    findPlaceByAlias,
    savePlace,
    deletePlace,
    expandSavedAliases,
  };
}

const defaultStore = createSavedPlacesStore({ storage: AsyncStorage });

export const listSavedPlaces = defaultStore.listSavedPlaces;
export const findPlaceByAlias = defaultStore.findPlaceByAlias;
export const savePlace = defaultStore.savePlace;
export const deletePlace = defaultStore.deletePlace;
export const expandSavedAliases = defaultStore.expandSavedAliases;
