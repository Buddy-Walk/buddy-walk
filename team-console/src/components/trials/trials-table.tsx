import type { MouseEvent } from "react";

import { buttonVariants } from "#/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import {
  formatDate,
  formatMeters,
  gpsBand,
  panoramaModeText,
  resolvedDestination,
  trialTime,
} from "#/lib/trials/display";
import { distanceGate } from "#/lib/trials/filters";
import { buildModules } from "#/lib/trials/modules";
import { RETRY_HISTORY_HASH } from "#/lib/trials/retry";
import type { Trial } from "#/lib/trials/schema";
import { cn } from "#/lib/utils";

import { GateBadge, ModuleBadge } from "./badges";
import { RetryCell } from "./retry-controls";
import { clickOpensRow, TrialLink, useOpenTrial } from "./trial-link";
import { QuickOutcome } from "./trial-review";

const COLUMNS = [
  "Time",
  "Destination / resolved address",
  "Distance gate",
  "GPS acc.",
  "Panorama",
  "Outcome",
  "Mod B (user image)",
  "Mod C (destination)",
  "Mod D (confidence)",
  "Mod E (guidance)",
  "Retry",
  "View",
];

const GPS_STYLES = {
  good: "text-pass-text",
  ok: "text-warn",
  poor: "text-fail-text",
} as const;

function DestinationCell({ trial }: { trial: Trial }) {
  const { requested, resolved, mismatch } = resolvedDestination(trial);
  return (
    <>
      <strong>{requested}</strong>
      <div className={cn("mt-1 text-xs text-muted-foreground", mismatch && "text-warn")}>
        {resolved ? `→ ${resolved}` : "Not resolved"}
      </div>
      {trial.retryOf ? (
        <div className="mt-1 text-xs text-replay-text">
          ↻ Retry, {panoramaModeText(trial.retryPanoramaMode)}
        </div>
      ) : trial.retryCount ? (
        <TrialLink
          trialId={trial._id}
          hash={RETRY_HISTORY_HASH}
          title="Open the retry history"
          className="mt-1 inline-flex rounded-full border border-replay-line bg-replay-soft px-2 py-0.5 text-xs font-bold whitespace-nowrap text-replay-text hover:border-replay"
        >
          ↻ {trial.retryCount} {trial.retryCount === 1 ? "retry" : "retries"}
        </TrialLink>
      ) : null}
    </>
  );
}

function TrialRow({ trial }: { trial: Trial }) {
  const openTrial = useOpenTrial();
  const modules = buildModules(trial);
  const gate = distanceGate(trial);

  const open = (event: MouseEvent<HTMLTableRowElement>) => {
    if (clickOpensRow(event)) void openTrial(trial._id);
  };

  return (
    <TableRow
      onClick={open}
      className={cn(
        "cursor-pointer",
        trial.retryOf && "[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-replay)]",
      )}
    >
      <TableCell>{formatDate(trialTime(trial))}</TableCell>
      <TableCell className="min-w-56 whitespace-normal">
        <DestinationCell trial={trial} />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <GateBadge mode={gate.mode} label={gate.label} />
          {gate.meters && <span className="font-bold">{gate.meters}</span>}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{trial.testScenario || "-"}</div>
      </TableCell>
      <TableCell>
        {trial.gpsAccuracyMeters == null ? (
          <span className="text-xs text-quiet">-</span>
        ) : (
          <span className={cn("font-bold", GPS_STYLES[gpsBand(trial.gpsAccuracyMeters)])}>
            ±{formatMeters(trial.gpsAccuracyMeters)}
          </span>
        )}
      </TableCell>
      <TableCell>
        {!trial.hasPanorama ? (
          <ModuleBadge status="na" label="None" />
        ) : (
          <ModuleBadge
            status="pass"
            label={trial.panoramaSource === "background" ? "Review only" : "Yes"}
          />
        )}
      </TableCell>
      <TableCell>
        <QuickOutcome trial={trial} />
      </TableCell>
      <TableCell>
        <ModuleBadge status={modules.moduleB.status} />
      </TableCell>
      <TableCell>
        <ModuleBadge status={modules.moduleC.status} />
      </TableCell>
      <TableCell>
        <ModuleBadge status={modules.moduleD.status} />
      </TableCell>
      <TableCell>
        <ModuleBadge status={modules.moduleE.status} />
      </TableCell>
      <TableCell>
        <RetryCell trial={trial} />
      </TableCell>
      <TableCell>
        <TrialLink
          trialId={trial._id}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          View
        </TrialLink>
      </TableCell>
    </TableRow>
  );
}

export function TrialsTable({ trials, message }: { trials: Trial[]; message?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader className="bg-muted">
          <TableRow>
            {COLUMNS.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {message || !trials.length ? (
            <TableRow>
              <TableCell
                colSpan={COLUMNS.length}
                className="py-8 text-center text-muted-foreground"
              >
                {message ?? "No Trials match the current filters."}
              </TableCell>
            </TableRow>
          ) : (
            trials.map((trial) => <TrialRow key={trial._id} trial={trial} />)
          )}
        </TableBody>
      </Table>
    </div>
  );
}
