import assert from "node:assert/strict";
import test from "node:test";
import { capturePeriod, selectHistoricalPanoramaCandidates, type HistoricalPanorama } from "../../server/services/lastMetersHistoricalPanoramas";

const TARGET = { lat: 40.7, lng: -74 };
const PLACE = "verified-shop";
const panorama = (panoId: string, date: string, changes: Partial<HistoricalPanorama> = {}): HistoricalPanorama =>
  ({ panoId, date, camera: TARGET, placeId: PLACE, ...changes });

test("historical capture dates represent complete calendar periods rather than publication timestamps", () => {
  assert.deepEqual(capturePeriod("2024"), { start: Date.UTC(2024, 0), end: Date.UTC(2025, 0) });
  assert.deepEqual(capturePeriod("2024-02"), { start: Date.UTC(2024, 1), end: Date.UTC(2024, 2) });
  for (const date of ["unknown", "2024-00", "2024-13", "2024-02-01", "1899", "2024-2", "2024-02T00:00Z"]) {
    assert.equal(capturePeriod(date), undefined, date);
  }
});

test("historical metadata rejects other businesses, remote cameras and unsafe panorama identifiers", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 27) });
  const items = [
    panorama("valid", "2025-01"),
    panorama("wrong-business", "2025-02", { placeId: "another-shop" }),
    panorama("far-camera", "2025-03", { camera: { lat: 41, lng: -74 } }),
    panorama("bad-camera", "2025-04", { camera: { lat: NaN, lng: -74 } }),
    panorama("https://private.example/image?key=secret", "2025-05"),
    panorama("x".repeat(161), "2025-06"),
  ];
  const selected = selectHistoricalPanoramaCandidates(items, Date.UTC(2026, 8), PLACE, TARGET);
  assert.deepEqual(selected.map(item => item.panorama.panoId), ["valid"]);
});

test("history must end before both the selected capture period and the present date", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 27) });
  const items = [panorama("older-month", "2026-08"), panorama("same-month", "2026-09"),
    panorama("overlapping-year", "2026"), panorama("future", "2027-01"), panorama("unknown", "")];
  assert.deepEqual(selectHistoricalPanoramaCandidates(items, Date.UTC(2026, 8), PLACE, TARGET)
    .map(item => item.panorama.panoId), ["older-month"]);
  assert.deepEqual(selectHistoricalPanoramaCandidates([panorama("future", "2027-01")], Date.UTC(2030, 0), PLACE, TARGET), []);
});

test("history inspects only the provider's first twelve metadata entries and orders eligible periods newest first", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 27) });
  const items = Array.from({ length: 12 }, (_, index) => panorama(`old-${index}`, `${2000 + index}-01`));
  items.push(panorama("outside-provider-bound", "2025-01"));
  const originalIds = items.map(item => item.panoId);
  const selected = selectHistoricalPanoramaCandidates(items, Date.UTC(2026, 8), PLACE, TARGET);
  assert.equal(selected.length, 12);
  assert.equal(selected[0].panorama.panoId, "old-11");
  assert.equal(selected.at(-1)?.panorama.panoId, "old-0");
  assert.deepEqual(items.map(item => item.panoId), originalIds, "selection must not reorder provider-owned metadata");
});
