/// <reference types="node" />
// Compares the console's Trials modules with the old page's functions on the same
// Trials from mobile/server, using read-only GETs. The two deliberate differences
// are counted rather than reported: values from older shapes the console reads as
// missing, and reviews from before outcome scoring, which count by their status.
//
//   bun run compare        against the seeded local stack
//   bun run compare:prod   against production (the prod secrets from Infisical)
//
// Exits 1 when anything else differs.
import {
  distanceGate,
  filterTrials,
  PRESETS,
  viewTrials,
  type TrialFilters,
} from "#/lib/trials/filters";
import { failureExplanation } from "#/lib/trials/failure";
import { buildModules } from "#/lib/trials/modules";
import { outcomeOf } from "#/lib/trials/outcome";
import {
  trialDetailResponseSchema,
  trialDetailSchema,
  trialListResponseSchema,
  trialSchema,
} from "#/lib/trials/schema";

import { loadOldPage } from "./old-page.ts";

type Row = Record<string, unknown> & { _id: string };

const { API_BASE_URL, ADMIN_TOKEN } = process.env;
if (!API_BASE_URL || !ADMIN_TOKEN) {
  console.error("Set API_BASE_URL and ADMIN_TOKEN, or use `bun run compare`.");
  process.exit(1);
}

const old = loadOldPage();
const EM_DASH = String.fromCharCode(0x2014);
let mismatches = 0;

function report(what: string, before: unknown, after: unknown) {
  mismatches++;
  if (mismatches <= 40) {
    console.log(
      `MISMATCH ${what}\n  old: ${JSON.stringify(before)}\n  new: ${JSON.stringify(after)}`,
    );
  }
}

// Key order and undefined-vs-missing don't matter; values do.
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined && v !== null)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;

function same(what: string, before: unknown, after: unknown) {
  if (JSON.stringify(canonical(before)) !== JSON.stringify(canonical(after))) {
    report(what, before, after);
  }
}

/** The old page writes em dashes where the console writes "-". */
const dashed = (value: unknown) =>
  JSON.parse(JSON.stringify(value ?? null).replaceAll(EM_DASH, "-"));

/** Text from the old page's HTML, with Trial capitalized as the console writes it. */
const text = (html: string) =>
  html
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("this trial", "this Trial")
    .replaceAll("This trial", "This Trial");

/** mobile/server's JSON as sent, so the old page's functions see exactly that. */
async function get<T>(path: string): Promise<{ data: T }> {
  const response = await fetch(new URL(path, API_BASE_URL), {
    headers: { "x-admin-token": ADMIN_TOKEN! },
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as { data: T };
}

// --- The two deliberate differences ------------------------------------------

/** The Trials each saved field was read as missing on. */
const readAsMissing = new Map<string, Set<string>>();
const countedByStatus = new Set<string>();

/**
 * The row as the console reads it, for the old page's functions: saved values the
 * schema reads as missing are left out, and a review from before outcome scoring
 * gets the outcome its status stood for.
 */
function asConsoleReads(
  raw: Row,
  parsed: Record<string, unknown>,
  fields: Record<string, unknown>,
): Row {
  const row: Row = { ...raw };
  for (const key of Object.keys(fields)) {
    const before = raw[key];
    const after = parsed[key];
    const missing = after === undefined && before != null;
    const shortened =
      Array.isArray(after) &&
      before != null &&
      JSON.stringify(before) !== JSON.stringify(after) &&
      (!Array.isArray(before) || before.length !== after.length);
    if (missing || shortened) {
      readAsMissing.set(key, (readAsMissing.get(key) ?? new Set()).add(raw._id));
      row[key] = after;
    }
  }
  if (
    !row.reviewOutcome &&
    typeof raw.reviewerStatus === "string" &&
    old.OUTCOME_FOR_STATUS[raw.reviewerStatus]
  ) {
    row.reviewOutcome = old.OUTCOME_FOR_STATUS[raw.reviewerStatus];
    countedByStatus.add(raw._id);
  }
  return row;
}

// --- Summary and failure text, read from the old page's HTML -----------------

function oldSummary(rows: Row[]) {
  const cards = old.summaryHtml(rows).split('<div class="summary-card">').slice(1);
  const table = (card: string) =>
    [
      ...card.matchAll(/<tr><td>(.*?)<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)%<\/td><\/tr>/g),
    ].map((m) => ({
      label: text(m[1]).replaceAll(` ${EM_DASH} `, " - "),
      scored: Number(m[2]),
      success: Number(m[3]),
      rate: Number(m[4]),
    }));
  const rate = cards[0].match(/big-number">(.*?)</)?.[1];
  const counts = cards[0].match(/(\d+) of (\d+) trials scored/) ?? [];
  const errors =
    cards[4].match(/Wrong turns: (\d+) \/ (\d+) scored<\/p><p>Wrong entrances: (\d+) \/ (\d+)/) ??
    [];
  return {
    rate: rate === EM_DASH ? null : Number(rate?.replace("%", "")),
    scored: Number(counts[1]),
    trials: Number(counts[2]),
    byWeek: table(cards[1]),
    byLocation: table(cards[2]),
    byVersion: table(cards[3]),
    wrongTurns: { wrong: Number(errors[1]), scored: Number(errors[2]) },
    wrongEntrances: { wrong: Number(errors[3]), scored: Number(errors[4]) },
  };
}

function oldFailure(row: Row) {
  const html = old.failureExplanation(row);
  if (!html) return null;
  return {
    heading: text(html.match(/<h3>(.*?)<\/h3>/)?.[1] ?? ""),
    summary: text(html.match(/<p>(.*?)<\/p>/s)?.[1] ?? ""),
    details: [...html.matchAll(/<li>(.*?)<\/li>/gs)].map((m) => text(m[1])),
  };
}

function compareModules(what: string, row: Row, trial: Parameters<typeof buildModules>[0]) {
  const before = old.buildModules(row);
  const after = buildModules(trial);
  for (const key of ["step0", "moduleB", "moduleC", "moduleD", "moduleE"] as const) {
    same(
      `${what} module ${key}`,
      dashed({
        status: before[key].status,
        durationMs: before[key].durationMs,
        title: before[key].title,
        metrics: before[key].metrics,
        raw: before[key].raw.map((step) => step.name),
      }),
      {
        status: after[key].status,
        durationMs: after[key].durationMs,
        title: after[key].title,
        metrics: after[key].metrics,
        raw: after[key].raw.map((step) => step.name),
      },
    );
  }
}

// --- Compare -----------------------------------------------------------------

const filterSets: TrialFilters[] = [
  {},
  ...Object.values(PRESETS).map((preset) => preset.filters as TrialFilters),
  { mode: "none" },
  { mode: "exact" },
  { mode: "aligned" },
  { panorama: "yes" },
  { outcome: "got_there" },
  { outcome: "needed_retake" },
  { outcome: "unscored" },
  { scenario: "test_a_visible" },
  { scenario: "no_panorama" },
  { scenario: "question_routed" },
  { q: "cvs" },
  { q: "st" },
  { q: "  Ave " },
  { mode: "exact", outcome: "unscored" },
];

for (const includeRetries of [false, true]) {
  const payload = await get<Row[]>(
    `/api/last-meters-tests?limit=500${includeRetries ? "&includeRetries=true" : ""}`,
  );
  const raw = payload.data;
  const trials = trialListResponseSchema.parse(payload).data;
  const rows = raw.map((row, i) => asConsoleReads(row, trials[i], trialSchema.shape));
  console.log(`\nList (includeRetries=${includeRetries}): ${raw.length} Trials`);

  for (const filters of filterSets) {
    const label = JSON.stringify(filters);
    const oldFilters = {
      mode: "",
      scenario: "",
      panorama: "",
      outcome: "",
      ...filters,
      q: filters.q?.trim() ?? "",
    };
    const { shown, summary } = viewTrials(trials, filters);
    same(
      `rows ${label}`,
      rows.filter((row) => old.matchesFilters(row, oldFilters)).map((row) => row._id),
      shown.map((trial) => trial._id),
    );
    const { success: _, ...summaryShown } = summary;
    same(
      `summary ${label}`,
      oldSummary(rows.filter((row) => old.matchesFilters(row, { ...oldFilters, outcome: "" }))),
      summaryShown,
    );
  }
  same("filterTrials {}", raw.length, filterTrials(trials, {}).length);

  rows.forEach((row, i) => {
    const trial = trials[i];
    same(`outcome ${row._id}`, old.outcomeOf(row), outcomeOf(trial));
    same(`gate ${row._id}`, dashed(old.distanceGate(row)), distanceGate(trial));
    compareModules(row._id, row, trial);
    same(`failure ${row._id}`, oldFailure(row), failureExplanation(trial));
  });
  console.log(`  compared ${filterSets.length} filter sets and ${rows.length} Trials`);

  // Details without images: every Trial with retries, and the newest 25.
  const sample = [
    ...raw.filter((row) => row.retryOf || row.retryCount).slice(0, 15),
    ...raw.slice(0, 25),
  ];
  for (const { _id } of sample) {
    const payload = await get<Row>(`/api/last-meters-tests/${encodeURIComponent(_id)}`);
    const detail = trialDetailResponseSchema.parse(payload).data;
    const row = asConsoleReads(payload.data, detail, trialDetailSchema.shape);
    same(`detail failure ${_id}`, oldFailure(row), failureExplanation(detail));
    compareModules(`detail ${_id}`, row, detail);
  }
  console.log(`  compared ${sample.length} details`);
}

// One detail with images, to check they come through the schema.
const newest = (await get<Row[]>("/api/last-meters-tests?limit=5")).data;
const withPanorama = newest.find((row) => row.hasPanorama) ?? newest[0];
const imageDetail = trialDetailResponseSchema.parse(
  await get(
    `/api/last-meters-tests/${encodeURIComponent(withPanorama._id)}?includeImages=true&includeStreetView=true`,
  ),
).data;
const shows = (image?: string) => (image?.startsWith("data:") ? "shows" : "missing");
console.log(
  `\nImages: user photo ${shows(imageDetail.userPhoto)}, panorama ${shows(imageDetail.panoramaPhoto)}`,
);

console.log("\nDeliberate differences from the old page:");
console.log(
  `  ${countedByStatus.size} Trials reviewed before outcome scoring count by their status`,
);
console.log(
  readAsMissing.size
    ? `  saved values read as missing (field: Trials): ${[...readAsMissing].map(([key, ids]) => `${key}: ${ids.size}`).join(", ")}`
    : "  no saved values read as missing",
);
console.log(`\n${mismatches} mismatches`);
process.exit(mismatches ? 1 : 0);
