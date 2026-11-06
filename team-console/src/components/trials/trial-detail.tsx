import type { ReactNode } from "react";

import {
  dataSourceFacts,
  formatMeters,
  formatRuntime,
  formatShortDate,
  MISSING,
  panoramaModeText,
  retryNumber,
  UNVERSIONED,
} from "#/lib/trials/display";
import { failureExplanation } from "#/lib/trials/failure";
import { buildModules, type TrialModule } from "#/lib/trials/modules";
import type { TrialDetail } from "#/lib/trials/schema";
import { cn } from "#/lib/utils";

import { ModuleBadge } from "./badges";
import { RETRY_HISTORY_HASH, RetryHistorySection } from "./retry-history";
import { TrialImages } from "./trial-images";
import { TrialLink } from "./trial-link";

function Block({
  title,
  className,
  children,
}: {
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("rounded-lg border bg-card p-4", className)}>
      {title && <div className="mb-3 flex items-center justify-between font-bold">{title}</div>}
      {children}
    </section>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="my-1 text-sm leading-snug text-muted-foreground">
      <b className="text-foreground">{label}:</b> {children}
    </p>
  );
}

function RetryBanner({ trial }: { trial: TrialDetail }) {
  if (!trial.retryOf) return null;
  const original = trial.history?.original;
  const number = trial.history && retryNumber(trial.history, trial._id);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-l-3 border-violet-300 border-l-violet-500 bg-violet-50 px-4 py-3 text-sm">
      <div>
        <b className="text-violet-800">Retry{number ? ` ${number}` : ""}</b> of the original Trial
        from {original ? formatShortDate(original.serverTs) : "an original that no longer exists"},{" "}
        {panoramaModeText(trial.retryPanoramaMode)}.
        <span className="block text-xs text-muted-foreground">
          Same stored photo and inputs as the original
          {trial.retryDefaultsApplied.length
            ? `; filled in ${trial.retryDefaultsApplied.join("; ")}`
            : ""}
          .
        </span>
      </div>
      {original && (
        <TrialLink
          trialId={original.id}
          className="rounded-md border bg-background px-2.5 py-1 text-xs font-semibold hover:bg-accent"
        >
          Open original
        </TrialLink>
      )}
    </div>
  );
}

function MetaFacts({ trial }: { trial: TrialDetail }) {
  const facts: [string, ReactNode][] = [
    ["Pipeline", trial.pipelineVersion || UNVERSIONED],
    [
      "Run",
      `${trial.runKind || "field"}${trial.retryOf ? ` | Source Trial: ${trial.retryOf}` : ""}`,
    ],
    ["Commit", trial.deployedCommit || "unknown"],
    [
      "Camera-origin visual bearing",
      trial.panoramaTargetHeading != null ? `${trial.panoramaTargetHeading}°` : "-",
    ],
    ["Safety gate", trial.safetyReasons.join(", ") || "No withheld reasons recorded"],
    ["Walking route", trial.walkingEvidence ? (trial.walkingEvidence.reason ?? "") : "not checked"],
    ["Confidence method", trial.confidenceMethod || "legacy"],
    [
      "Mode",
      trial.navigationMode === "approach" ? "Mode A (Navigation)" : "Mode B (Fine Localization)",
    ],
    ["Scenario", trial.testScenario || "-"],
    ["Distance", formatMeters(trial.destinationDistanceMeters)],
    [
      "Bearing",
      trial.destinationBearing != null ? `${Math.round(trial.destinationBearing)}°` : "-",
    ],
    ["Latency", trial.latencyMs != null ? `${trial.latencyMs} ms` : "-"],
  ];
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-x-4">
      {facts.map(([label, value]) => (
        <div key={label}>
          <b className="text-foreground">{label}:</b> {value}
        </div>
      ))}
    </div>
  );
}

function FailureSummary({ trial }: { trial: TrialDetail }) {
  const failure = failureExplanation(trial);
  if (!failure) return null;
  return (
    <section className="rounded-lg border border-destructive bg-red-50 px-4 py-3.5">
      <h3 className="mb-2 font-bold text-red-800">{failure.heading}</h3>
      <p className="leading-relaxed">{failure.summary}</p>
      {failure.details.length > 0 && (
        <ul className="mt-2.5 list-disc pl-5 text-sm text-muted-foreground">
          {failure.details.map((detail, i) => (
            <li key={i}>{detail}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DataSources({ trial }: { trial: TrialDetail }) {
  const facts = dataSourceFacts(trial);
  return (
    <Block title="Data sources">
      <Metric label="Used for this answer">{facts.used}</Metric>
      {facts.imagery && <Metric label="Logged imagery">{facts.imagery}</Metric>}
      <Metric label="Destination target">{facts.target}</Metric>
      <Metric label="GPS allowance on the 250 m gate">{facts.allowance}</Metric>
      <Metric label="Google Maps open now">{facts.openNow}</Metric>
      {facts.searchedAs && <Metric label="Searched as">{facts.searchedAs}</Metric>}
    </Block>
  );
}

function PlaceCandidates({ trial }: { trial: TrialDetail }) {
  const candidates = trial.placeCandidates;
  if (!candidates.length) return null;
  return (
    <details className="rounded-lg border bg-card p-4">
      <summary className="cursor-pointer font-bold">
        Google Places candidates ({candidates.length}; searches:{" "}
        {trial.placesSearches.join(" + ") || "-"})
      </summary>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              {["Place", "Distance", "Relevance filter", "Search", "Types"].map((column) => (
                <th key={column} className="p-2 font-bold">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate, i) => {
              const chosen =
                candidate.name !== undefined &&
                candidate.name === trial.destinationPlaceName &&
                candidate.address === trial.destinationPlaceAddress;
              return (
                <tr key={i} className="border-t align-top">
                  <td className="p-2">
                    {candidate.name} {chosen && <b>(chosen)</b>}
                    <div className="text-xs text-muted-foreground">{candidate.address}</div>
                  </td>
                  <td className="p-2 whitespace-nowrap">
                    {candidate.distanceMeters === undefined
                      ? MISSING
                      : `${candidate.distanceMeters} m`}
                  </td>
                  <td
                    className={cn(
                      "p-2 font-bold",
                      candidate.relevant ? "text-emerald-700" : "text-red-700",
                    )}
                  >
                    {candidate.relevant ? "kept" : "rejected"}
                  </td>
                  <td className="p-2">{candidate.source}</td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {candidate.types.join(", ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ModuleBlock({ module }: { module: TrialModule }) {
  return (
    <Block
      title={
        <>
          <span>
            {module.title} - Runtime: {formatRuntime(module.durationMs)}
          </span>
          <ModuleBadge status={module.status} />
        </>
      }
    >
      {module.metrics.map(([label, value]) => (
        <Metric key={label} label={label}>
          {value}
        </Metric>
      ))}
      {module.raw.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-semibold text-primary select-none">
            View AI step prompts & responses ({module.raw.length} calls)
          </summary>
          {module.raw.map((step, i) => (
            <pre
              key={i}
              className="mt-2 rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
            >
              <b>[{step.name}]</b> ({step.model}) - {step.success ? "SUCCESS" : "FAILED"}
              {"\n\nPROMPT:\n"}
              {step.prompt || "-"}
              {"\n\nRESPONSE:\n"}
              {step.response || step.error || "-"}
            </pre>
          ))}
        </details>
      )}
    </Block>
  );
}

/** Everything one Trial recorded, in the order the old dashboard showed it. */
export function TrialDetailBody({ trial }: { trial: TrialDetail }) {
  const modules = buildModules(trial);
  const timedSteps = trial.steps.filter((step) => typeof step.durationMs === "number");

  return (
    <div className="flex flex-col gap-4">
      <RetryBanner trial={trial} />
      <TrialImages trial={trial} />

      {trial.panoramaValidation.length > 0 && (
        <Block title="Outdoor panorama validation">
          {trial.panoramaValidation.map((attempt, i) => (
            <p key={i} className="my-1 text-sm text-muted-foreground">
              <b className="text-foreground">{attempt.status}</b>: {attempt.reason}
              {attempt.panoId && ` | Panorama: ${attempt.panoId}`}
              {attempt.distanceMeters != null && ` | Camera distance: ${attempt.distanceMeters} m`}
            </p>
          ))}
        </Block>
      )}

      {timedSteps.length > 0 && (
        <Block title="Vision timing (parallel work may overlap)">
          {timedSteps.map((step, i) => (
            <p key={i} className="my-1 text-sm">
              {step.name}: {step.durationMs} ms{step.panoId && ` | ${step.panoId}`}
            </p>
          ))}
        </Block>
      )}

      <MetaFacts trial={trial} />
      <FailureSummary trial={trial} />
      {trial.history && (
        <RetryHistorySection id={RETRY_HISTORY_HASH} trial={trial} history={trial.history} />
      )}
      <DataSources trial={trial} />
      <PlaceCandidates trial={trial} />
      <ModuleBlock module={modules.step0} />
      <ModuleBlock module={modules.moduleB} />
      <ModuleBlock module={modules.moduleC} />
      <ModuleBlock module={modules.moduleD} />
      <ModuleBlock module={modules.moduleE} />

      <Block title="Final output sent to user" className="border-2 border-blue-500 bg-blue-50/50">
        <p className="leading-relaxed">{trial.finalOutput || trial.error || "-"}</p>
      </Block>
    </div>
  );
}
