import { ChevronDownIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { PANORAMA_MODE_LABELS, trialName } from "#/lib/trials/display";
import { elapsedText, originalIdOf, retryBlockedReason } from "#/lib/trials/retry";
import type { PanoramaMode, RetryAvailability, RunningRetry, Trial } from "#/lib/trials/schema";
import { cn } from "#/lib/utils";

import { useAskToRetry, useRetryAvailability, useRunningRetries } from "./retries";

/** Seconds since a retry started, counting up. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return <span className="tabular-nums">{elapsedText(since, now)}</span>;
}

/** Labels a reason as the cause of a disabled Retry, so it doesn't read as notes on the Trial. */
export function RetryReason({
  title,
  className,
  children,
}: {
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div title={title} className={cn("text-xs leading-snug text-muted-foreground", className)}>
      <b className="block text-warn">Can&apos;t retry</b>
      {children}
    </div>
  );
}

function ModeItem({
  label,
  disabled,
  onSelect,
  children,
}: {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onSelect}
      className="flex-col items-start gap-0.5 focus:bg-replay-soft focus:*:[b]:text-replay-text"
    >
      <b className="font-semibold">{label}</b>
      <span className="text-xs leading-snug text-muted-foreground">{children}</span>
    </DropdownMenuItem>
  );
}

/** The Retry button. The panorama is chosen in the menu it opens. */
export function RetryButton({
  trial,
  running,
  blocked,
}: {
  trial: Trial;
  running: RunningRetry | undefined;
  blocked: string;
}) {
  const askToRetry = useAskToRetry();
  const trigger = useRef<HTMLButtonElement>(null);

  if (running) {
    return (
      <Button
        variant="secondary"
        size="sm"
        disabled
        className="border-replay-line bg-replay-soft text-replay-text disabled:opacity-100"
      >
        <Loader2Icon aria-hidden className="animate-spin" />
        Running <Elapsed since={running.startedAt} />
      </Button>
    );
  }
  if (blocked) {
    return (
      <Button variant="secondary" size="sm" disabled title={blocked}>
        Retry
      </Button>
    );
  }

  const name = trialName(trial) || "this Trial";
  const panorama = trial.replay.originalPanorama;
  const fills = trial.replay.defaultsApplied;
  const retry = (panoramaMode: PanoramaMode) => {
    void askToRetry(
      { trialId: trial._id, originalId: originalIdOf(trial), name },
      panoramaMode,
      trigger.current,
    );
  };

  return (
    // Not modal: a modal menu handing over to the confirm dialog can leave the page unclickable.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="secondary"
          size="sm"
          className="hover:border-replay aria-expanded:border-replay"
        >
          Retry
          <ChevronDownIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(320px,calc(100vw-2rem))] border-replay-line"
      >
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          Re-run {name} with
        </DropdownMenuLabel>
        <ModeItem label={PANORAMA_MODE_LABELS.fresh} onSelect={() => retry("fresh")}>
          Fetch Street View the way a Trial from the app would today.
        </ModeItem>
        <ModeItem
          label={PANORAMA_MODE_LABELS.original}
          disabled={!panorama.available}
          onSelect={() => retry("original")}
        >
          {panorama.available ? (
            <>
              Reuse the original Trial&apos;s Street View image so only the code differs.{" "}
              {panorama.panoramaDate && `Captured ${panorama.panoramaDate}, `}
              <span className="font-mono">{panorama.panoId}</span>
            </>
          ) : (
            panorama.reason || "The original panorama is unknown."
          )}
        </ModeItem>
        {fills.length > 0 && (
          <p className="mt-1 border-t px-2 pt-2 pb-1 text-xs leading-snug text-warn">
            Fills in values the original did not record: {fills.join("; ")}
          </p>
        )}
        <p className="mt-1 border-t px-2 pt-2 pb-1 text-xs leading-snug text-quiet">
          Runs the current pipeline with paid API calls, usually in about a minute. Up to 3 retries
          run at once, one per Trial. The result is saved as a new Trial.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The table's Retry column: the button, and why it is off or which values a replay fills in. */
export function RetryCell({ trial }: { trial: Trial }) {
  const availability = useRetryAvailability();
  const running = useRunningRetries().get(originalIdOf(trial)) ?? trial.runningRetry;
  const blocked = running ? "" : retryBlockedReason(trial, availability);
  const fills = trial.replay.defaultsApplied;
  return (
    <div className="min-w-44">
      <RetryButton trial={trial} running={running} blocked={blocked} />
      {blocked ? (
        // A server-wide reason is spelled out once, in the note above the list.
        <RetryReason
          title={blocked}
          className="mt-1.5 line-clamp-6 max-w-[220px] whitespace-normal"
        >
          {availability.available
            ? blocked
            : "Retries are off on this server. See the note above the list."}
        </RetryReason>
      ) : (
        fills.length > 0 && (
          <div className="mt-1.5 text-xs text-warn" title={fills.join("; ")}>
            Fills in {fills.length} {fills.length === 1 ? "value" : "values"}
          </div>
        )
      )}
    </div>
  );
}

export function RetriesOffNote({ availability }: { availability: RetryAvailability }) {
  if (availability.available) return null;
  return (
    <div className="rounded-lg border border-l-3 border-warn/35 border-l-warn bg-warn/8 px-3.5 py-2.5 text-sm">
      <b className="text-warn">Retries are off.</b> {availability.reason}
    </div>
  );
}
