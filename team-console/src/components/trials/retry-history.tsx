import { Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import {
  formatDate,
  formatShortDate,
  PANORAMA_MODE_LABELS,
  shortCommit,
} from "#/lib/trials/display";
import { outcomeOf } from "#/lib/trials/outcome";
import { retryBlockedReason } from "#/lib/trials/retry";
import type {
  RetryHistory,
  RetryHistoryEntry,
  RunningRetry,
  TrialDetail,
} from "#/lib/trials/schema";
import { cn } from "#/lib/utils";

import { ModuleBadge, OutcomeMark } from "./badges";
import { Elapsed, RetryButton, RetryReason } from "./retry-controls";
import { useRetryAvailability, useRunningRetries } from "./retries";
import { clickOpensRow, TrialLink, useOpenTrial } from "./trial-link";

// The order is a per-browser preference; storage can be unavailable.
const ORDER_KEY = "trials.historyNewestFirst";

function readNewestFirst(): boolean {
  try {
    return localStorage.getItem(ORDER_KEY) === "1";
  } catch {
    return false;
  }
}

function saveNewestFirst(newestFirst: boolean) {
  try {
    localStorage.setItem(ORDER_KEY, newestFirst ? "1" : "0");
  } catch {
    // Keep it for this visit.
  }
}

const changed = "text-warn";

function PanoramaCell({
  entry,
  original,
}: {
  entry: RetryHistoryEntry;
  original: RetryHistoryEntry | null;
}) {
  const panoChanged = entry.isRetry && original && entry.panoId && entry.panoId !== original.panoId;
  return (
    <>
      {entry.isRetry
        ? entry.panoramaMode
          ? PANORAMA_MODE_LABELS[entry.panoramaMode]
          : "-"
        : "From the app"}
      <div
        className={cn("mt-1 text-xs text-muted-foreground", panoChanged && changed)}
        title={
          entry.panoramaSource === "background"
            ? "Saved after the answer, for review only"
            : undefined
        }
      >
        {entry.panoId || entry.panoramaDate ? (
          <>
            {entry.panoramaDate || "Undated"}{" "}
            {entry.panoId && <span className="font-mono">{entry.panoId}</span>}
          </>
        ) : (
          entry.panoramaStatus || "None"
        )}
        {panoChanged && (
          <div>
            (was <span className="font-mono">{original.panoId}</span>)
          </div>
        )}
      </div>
    </>
  );
}

function ResultCell({
  entry,
  original,
}: {
  entry: RetryHistoryEntry;
  original: RetryHistoryEntry | null;
}) {
  const scenarioChanged = entry.isRetry && original && entry.testScenario !== original.testScenario;
  return (
    <>
      <ModuleBadge
        status={entry.success ? "pass" : "fail"}
        label={entry.success ? "Answered" : "Failed"}
      />
      <div className={cn("mt-1 text-xs text-muted-foreground", scenarioChanged && changed)}>
        {entry.testScenario || "-"}
        {scenarioChanged && ` (was ${original.testScenario || "-"})`}
        {entry.error && <div>{entry.error}</div>}
        {entry.safetyReasons.length > 0 && <div>Withheld: {entry.safetyReasons.join(", ")}</div>}
      </div>
      {entry.defaultsApplied.length > 0 && (
        <div className={cn("mt-1 text-xs", changed)}>
          Filled in: {entry.defaultsApplied.join("; ")}
        </div>
      )}
      {entry.finalOutput && (
        <div className="mt-1 line-clamp-3 max-w-[46ch]" title={entry.finalOutput}>
          {entry.finalOutput}
        </div>
      )}
    </>
  );
}

function HistoryRow({
  entry,
  label,
  current,
  original,
}: {
  entry: RetryHistoryEntry;
  label: string;
  current: boolean;
  original: RetryHistoryEntry | null;
}) {
  const openTrial = useOpenTrial();

  // A run opens its own detail; the one being viewed is already open.
  const open = (event: MouseEvent<HTMLTableRowElement>) => {
    if (!current && clickOpensRow(event)) void openTrial(entry.id);
  };

  return (
    <tr
      onClick={open}
      data-current={current || undefined}
      className={cn(
        "border-b align-top last:border-b-0",
        !entry.isRetry && "border-b-2 border-b-border-strong",
        current
          ? "bg-replay-soft [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-replay)]"
          : "cursor-pointer hover:bg-muted",
      )}
    >
      <td className="p-2.5">
        {current ? (
          <span aria-current="true" className="font-bold whitespace-nowrap">
            {label}
            <span className="mt-1 block text-xs text-replay">Viewing</span>
          </span>
        ) : (
          <TrialLink
            trialId={entry.id}
            className="font-bold whitespace-nowrap hover:text-replay-text hover:underline"
          >
            {label}
          </TrialLink>
        )}
      </td>
      <td className="p-2.5 whitespace-nowrap tabular-nums" title={formatDate(entry.serverTs)}>
        {formatShortDate(entry.serverTs)}
      </td>
      <td className="p-2.5">
        <PanoramaCell entry={entry} original={original} />
      </td>
      <td className="p-2.5">
        <ResultCell entry={entry} original={original} />
      </td>
      <td className="min-w-30 p-2.5">
        <OutcomeMark outcome={outcomeOf(entry)} />
      </td>
      <td className="p-2.5 whitespace-nowrap">
        {entry.pipelineVersion || entry.deployedCommit ? (
          <>
            {entry.pipelineVersion || "unversioned"}
            {entry.deployedCommit && (
              <div className="font-mono text-xs" title={entry.deployedCommit}>
                {shortCommit(entry.deployedCommit)}
              </div>
            )}
          </>
        ) : (
          "Not recorded"
        )}
      </td>
    </tr>
  );
}

function RunningRow({ running, label }: { running: RunningRetry; label: string }) {
  return (
    <tr className="border-b align-top last:border-b-0">
      <td className="p-2.5">
        <span className="inline-flex items-center gap-1.5 font-bold whitespace-nowrap text-replay-text">
          <Loader2Icon aria-hidden className="size-3 animate-spin" />
          {label}
        </span>
      </td>
      <td className="p-2.5 whitespace-nowrap tabular-nums">
        Running <Elapsed since={running.startedAt} />
      </td>
      <td className="p-2.5">{PANORAMA_MODE_LABELS[running.panoramaMode]}</td>
      <td colSpan={3} className="p-2.5 text-muted-foreground">
        Waiting for the pipeline. This can take up to a minute.
      </td>
    </tr>
  );
}

/** Every run of one field Trial: the original pinned first, then its numbered retries. */
export function RetryHistorySection({
  id,
  trial,
  history,
}: {
  id: string;
  trial: TrialDetail;
  history: RetryHistory;
}) {
  const [newestFirst, setNewestFirst] = useState(readNewestFirst);
  const scroller = useRef<HTMLDivElement>(null);
  const { original, retries } = history;
  const availability = useRetryAvailability();
  const running = useRunningRetries().get(history.originalId) ?? history.runningRetry;
  const blocked = retryBlockedReason(trial, availability);

  // Retries keep their numbers in either order.
  const runs: (
    | { entry: RetryHistoryEntry; label: string }
    | { running: RunningRetry; label: string }
  )[] = retries.map((entry, i) => ({ entry, label: `Retry ${i + 1}` }));
  if (running) runs.push({ running, label: `Retry ${retries.length + 1}` });
  if (newestFirst) runs.reverse();

  // Scrolls the capped table, not the page, so the run being viewed is fully visible.
  useEffect(() => {
    const box = scroller.current;
    const row = box?.querySelector<HTMLElement>("tr[data-current]");
    if (!box || !row) return;
    const top = box.getBoundingClientRect().top + (box.querySelector("thead")?.offsetHeight ?? 0);
    const { top: rowTop, bottom: rowBottom } = row.getBoundingClientRect();
    const bottom = box.getBoundingClientRect().bottom;
    if (rowTop < top) box.scrollTop -= top - rowTop;
    else if (rowBottom > bottom) box.scrollTop += rowBottom - bottom;
  }, [trial._id]);

  const chooseOrder = (newest: boolean) => {
    if (newest === newestFirst) return;
    setNewestFirst(newest);
    saveNewestFirst(newest);
    if (scroller.current) scroller.current.scrollTop = 0;
  };

  return (
    <section id={id} className="scroll-mt-4 rounded-lg border border-replay-line p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-bold">Retry history</h3>
          <p className="text-xs text-quiet">
            {retries.length
              ? `${retries.length} ${retries.length === 1 ? "retry" : "retries"} of the original Trial.`
              : "No retries yet. A retry re-runs the stored photo and inputs through the current pipeline."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {runs.length > 1 && (
            <div
              role="group"
              aria-label="Order of retries"
              className="inline-flex rounded-lg border bg-background p-0.5"
            >
              {[
                [false, "Oldest first"],
                [true, "Newest first"],
              ].map(([newest, text]) => (
                <button
                  key={String(newest)}
                  type="button"
                  aria-pressed={newestFirst === newest}
                  onClick={() => chooseOrder(newest as boolean)}
                  className="rounded-md px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-muted-foreground hover:text-foreground aria-pressed:bg-replay-soft aria-pressed:text-replay-text aria-pressed:shadow-[inset_0_0_0_1px_var(--color-replay-line)]"
                >
                  {text}
                </button>
              ))}
            </div>
          )}
          <RetryButton trial={trial} running={running} blocked={blocked} />
        </div>
      </div>
      {blocked && !running && <RetryReason className="-mt-1 mb-3">{blocked}</RetryReason>}
      <div
        ref={scroller}
        tabIndex={0}
        role="region"
        aria-label="Retry runs"
        className="max-h-[min(400px,60vh)] overflow-auto overscroll-contain rounded-lg border"
      >
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-1 bg-muted text-left text-muted-foreground shadow-[inset_0_-1px_0_var(--color-border)]">
            <tr>
              {["Run", "Ran at", "Panorama", "Result and final output", "Review", "Pipeline"].map(
                (column) => (
                  <th key={column} className="p-2.5 font-bold whitespace-nowrap">
                    {column}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {original ? (
              <HistoryRow
                entry={original}
                label="Original"
                current={original.id === trial._id}
                original={original}
              />
            ) : (
              <tr className="border-b-2 border-b-border-strong">
                <td colSpan={6} className="p-2.5 text-quiet">
                  The original Trial no longer exists.
                </td>
              </tr>
            )}
            {runs.map((run) =>
              "entry" in run ? (
                <HistoryRow
                  key={run.entry.id}
                  entry={run.entry}
                  label={run.label}
                  current={run.entry.id === trial._id}
                  original={original}
                />
              ) : (
                <RunningRow key="running" running={run.running} label={run.label} />
              ),
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2.5 text-xs text-quiet">
        Retries are saved as their own Trials. Score them like Trials from the app; they never count
        toward the success rate.
      </p>
    </section>
  );
}
