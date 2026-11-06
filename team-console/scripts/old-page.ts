/// <reference types="node" />
// Loads the pure functions of mobile/server's old Trials page (lastMetersTests.html)
// into a vm, so scripts/compare-with-old-page.ts can compare their outputs with the
// console's. Delete both once the old page is retired.
import { readFileSync } from "node:fs";
import vm from "node:vm";

type Row = Record<string, unknown>;

export interface OldPage {
  OUTCOME_FOR_STATUS: Record<string, string>;
  outcomeOf(row: Row): string;
  matchesFilters(row: Row, filters: Record<string, string>): boolean;
  distanceGate(row: Row): unknown;
  buildModules(row: Row): Record<string, OldModule>;
  failureExplanation(row: Row): string;
  /** The summary cards' HTML for these rows. */
  summaryHtml(rows: Row[]): string;
}

export interface OldModule {
  status: string;
  durationMs?: number;
  title: string;
  metrics: unknown;
  raw: { name: string }[];
}

const html = readFileSync(
  new URL("../../mobile/server/views/lastMetersTests.html", import.meta.url),
  "utf8",
);
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

/** The page's script from the line starting `from` up to the one starting `to`. */
function slice(from: string, to: string) {
  const start = script.indexOf(from);
  const end = script.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`The old page no longer has ${from} ... ${to}.`);
  return script.slice(start, end);
}

export function loadOldPage(): OldPage {
  const summary = { innerHTML: "" };
  const context = vm.createContext({ document: { getElementById: () => summary } });
  vm.runInContext(
    [
      slice("var OUTCOME_LABELS", "function saveReview("),
      slice("function esc(", "function idOf("),
      slice("// --- Module Logic ---", "// --- Detail Modal Render ---"),
      slice("function noPanoramaReason(", "function candidatesHtml("),
      slice("function distanceGate(", "function gpsAccuracyHtml("),
      slice("var allTests = [];", "function applyFilters("),
    ].join("\n"),
    context,
  );
  context.summaryHtml = (rows: Row[]) => {
    context.renderSummary(rows);
    return summary.innerHTML;
  };
  return context as OldPage;
}
