import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSavedPlacesStore, type SavedPlacesStorage } from './savedPlaces.ts';

/**
 * Provide an isolated AsyncStorage-like fixture whose serialized value can be inspected or
 * corrupted by a test.
 */
function memoryStorage(initialValue: string | null = null): SavedPlacesStorage & { written: string | null } {
  return {
    written: initialValue,
    /** Read the fixture's current serialized saved-place value. */
    async getItem() {
      return this.written;
    },
    /** Capture the serialized value written by the saved-place store. */
    async setItem(_key: string, value: string) {
      this.written = value;
    },
  };
}

describe('savedPlaces store', () => {
  // Group regression cases for: savedPlaces store.
  it('saves, trims, and finds places by case-insensitive alias', async () => {
    // Regression test: saves, trims, and finds places by case-insensitive alias.
    const storage = memoryStorage();
    const store = createSavedPlacesStore({
      storage,
      /** Freeze save time so creation/update timestamps are deterministic. */
      now: () => new Date('2026-05-05T12:00:00.000Z'),
      /** Freeze the random ID component for repeatable new-place assertions. */
      random: () => 0.123456,
    });

    const saved = await store.savePlace({
      alias: ' Home ',
      address: ' 123 Main St ',
      lat: 40.7,
      lon: -73.9,
    });

    assert.equal(saved.alias, 'Home');
    assert.equal(saved.address, '123 Main St');
    assert.equal(saved.createdAt, '2026-05-05T12:00:00.000Z');
    assert.equal((await store.findPlaceByAlias('home'))?.id, saved.id);
    assert.equal((await store.findPlaceByAlias(' HOME '))?.address, '123 Main St');
  });

  it('updates an existing alias instead of duplicating it', async () => {
    // Regression test: updates an existing alias instead of duplicating it.
    const store = createSavedPlacesStore({
      storage: memoryStorage(),
      /** Use a stable timestamp while checking case-insensitive alias updates. */
      now: () => new Date('2026-05-05T12:00:00.000Z'),
      /** Use a stable random value so alias-update assertions do not depend on ID entropy. */
      random: () => 0.5,
    });

    const first = await store.savePlace({ alias: 'Work', address: '1 First Ave' });
    const updated = await store.savePlace({ alias: ' work ', address: '2 Second Ave' });
    const all = await store.listSavedPlaces();

    assert.equal(updated.id, first.id);
    assert.equal(updated.createdAt, first.createdAt);
    assert.equal(updated.alias, 'work');
    assert.equal(updated.address, '2 Second Ave');
    assert.equal(all.length, 1);
  });

  it('includes coordinates in expanded text when a place has lat/lon', async () => {
    // Regression test: includes coordinates in expanded text when a place has lat/lon.
    const store = createSavedPlacesStore({ storage: memoryStorage() });
    await store.savePlace({
      alias: 'gym',
      address: '200 Fitness Ave, Brooklyn, NY',
      lat: 40.6925,
      lon: -73.9857,
    });

    const expanded = await store.expandSavedAliases('How do I get to gym?');
    assert.equal(
      expanded.text,
      'How do I get to 200 Fitness Ave, Brooklyn, NY (coordinates 40.6925, -73.9857)?'
    );
  });

  it('expands saved aliases as whole words and prefers longer aliases first', async () => {
    // Regression test: expands saved aliases as whole words and prefers longer aliases first.
    const store = createSavedPlacesStore({ storage: memoryStorage() });
    await store.savePlace({ alias: 'home', address: '123 Main St' });
    await store.savePlace({ alias: 'home base', address: '500 Base Rd' });
    await store.savePlace({ alias: 'c++', address: 'Library Desk' });

    const expanded = await store.expandSavedAliases(
      'Walk from home base to home, not homeward, then ask for c++ help.'
    );

    assert.equal(
      expanded.text,
      'Walk from 500 Base Rd to 123 Main St, not homeward, then ask for Library Desk help.'
    );
    assert.deepEqual(
      expanded.matched.map(/* Read matched alias names to check longest-first matching and replacement order. */ (place) => place.alias),
      ['home base', 'home', 'c++']
    );
  });

  it('deletes places and tolerates invalid stored payloads', async () => {
    // Regression test: deletes places and tolerates invalid stored payloads.
    const storage = memoryStorage();
    const store = createSavedPlacesStore({ storage, warn: /* Suppress the expected malformed-storage warning in the corruption-recovery case. */ () => undefined });

    const saved = await store.savePlace({ alias: 'Pharmacy', address: '10 Health Way' });
    await store.deletePlace(saved.id);
    assert.deepEqual(await store.listSavedPlaces(), []);

    storage.written = '{bad json';
    assert.deepEqual(await store.listSavedPlaces(), []);
  });
});
