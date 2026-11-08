import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { TrialDetailBody } from "#/components/trials/trial-detail";
import { useRunningRetries } from "#/components/trials/retries";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { keepOpenForToast } from "#/components/ui/sonner";
import { formatDate, trialName, trialTime } from "#/lib/trials/display";
import { originalIdOf, RETRY_HISTORY_HASH, retryPollInterval } from "#/lib/trials/retry";
import type { TrialDetail } from "#/lib/trials/schema";
import { trialQuery, trialRunsQuery, trialsQuery } from "#/server/trials";

const trialsRoute = getRouteApi("/trials");

// No loader: the detail opens at once from the list's row, and its images
// (about 1 MB) fill in when they arrive, so a slow load never blanks the Trial.
export const Route = createFileRoute("/trials/$trialId")({
  component: TrialDetailDialog,
});

function TrialDetailDialog() {
  const { trialId } = Route.useParams();
  const deps = trialsRoute.useLoaderDeps();
  const navigate = trialsRoute.useNavigate();
  const router = useRouter();
  const { trialDepth, hash } = useLocation({
    select: (location) => ({ trialDepth: location.state.trialDepth, hash: location.hash }),
  });
  const content = useRef<HTMLDivElement>(null);

  const listRow = useQuery({
    ...trialsQuery(deps),
    select: ({ trials }) => trials.find((trial) => trial._id === trialId),
  }).data;
  const detail = useQuery(trialQuery(trialId));
  const shown: TrialDetail | undefined =
    detail.data ?? (listRow && { ...listRow, placeCandidates: [] });

  // The history can change while the Trial is open, so it comes from its own
  // light query, polled while one of this Trial's retries runs.
  const runningHere = useRunningRetries();
  const runs = useQuery({
    ...trialRunsQuery(trialId),
    refetchInterval: ({ state: { data } }) =>
      retryPollInterval(
        [data?.history?.runningRetry],
        data !== undefined && runningHere.has(originalIdOf(data)),
      ),
    refetchIntervalInBackground: true,
  }).data;
  const trial: TrialDetail | undefined =
    shown && runs ? { ...shown, history: runs.history, replay: runs.replay } : shown;
  const hasHistory = Boolean(trial?.history);

  // Closing goes back to the list rather than adding to history. A Trial opened
  // from a shared link has no list behind it, so the list replaces it.
  const close = () => {
    if (trialDepth) router.history.go(-trialDepth);
    else void navigate({ to: "/trials", search: true, replace: true, resetScroll: false });
  };

  // A Trial opened from inside the dialog starts at its top. The braces matter:
  // scrollTo returns a Promise in current browsers, which React would call as a cleanup.
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [trialId]);

  // The retry count on a row links here; the history arrives with the detail.
  useEffect(() => {
    if (hash === RETRY_HISTORY_HASH && hasHistory) {
      document.getElementById(RETRY_HISTORY_HASH)?.scrollIntoView({ block: "start" });
    }
  }, [hash, hasHistory, trialId]);

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        ref={content}
        showCloseButton={false}
        onInteractOutside={keepOpenForToast}
        className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-[900px]"
      >
        <DialogHeader className="flex-row items-center justify-between gap-4 border-b pb-4">
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl">
              {trial ? trialName(trial) || "Unknown destination" : "Loading…"}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {trial &&
                [
                  formatDate(trialTime(trial)),
                  [trial.lat, trial.lng].filter((v) => v != null).join(", "),
                ].join(" | ")}
            </DialogDescription>
          </div>
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
        </DialogHeader>

        {detail.isError && (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              {trial
                ? `Could not load the saved images for this Trial. ${detail.error.message}`
                : `Could not load this Trial (${detail.error.message}).`}
              <Button size="sm" variant="secondary" onClick={() => detail.refetch()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {trial ? (
          <TrialDetailBody trial={trial} />
        ) : (
          !detail.isError && <p className="p-6 text-center text-muted-foreground">Loading Trial…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
