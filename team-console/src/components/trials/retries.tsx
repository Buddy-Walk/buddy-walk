import {
  useMutation,
  useMutationState,
  useQueryClient,
  type Mutation,
} from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Button, buttonVariants } from "#/components/ui/button";
import { showToast, Toaster } from "#/components/ui/toast";
import { panoramaModeText } from "#/lib/trials/display";
import {
  forgetPendingRetry,
  newIdempotencyKey,
  readPendingRetries,
  RETRIES_ON,
  RETRY_HISTORY_HASH,
  RetryRefused,
  savePendingRetry,
  sendUntilAnswered,
  type FinishedRetry,
  type RetryRun,
} from "#/lib/trials/retry";
import type {
  PanoramaMode,
  RetryAvailability,
  RunningRetry,
  TrialDetail,
} from "#/lib/trials/schema";
import { isTrialRunsQuery, retryTrial, type TrialList } from "#/server/trials";

import { ModuleBadge } from "./badges";
import { TrialLink } from "./trial-link";

const RETRY_KEY = ["retry"];

/** What a retry needs to know about the Trial it replays. */
export type RetryTarget = Pick<RetryRun, "trialId" | "originalId" | "name">;

const runOf = (mutation: Mutation<any, any, any, any>) => mutation.state.variables as RetryRun;

/** Retries this tab is sending, by original, wherever they were started from. */
export function useRunningRetries(): Map<string, RunningRetry> {
  const runs = useMutationState({
    filters: { mutationKey: RETRY_KEY, status: "pending" },
    select: runOf,
  });
  return useMemo(
    () =>
      new Map(
        runs.map(({ originalId, panoramaMode, startedAt }) => [
          originalId,
          { panoramaMode, startedAt },
        ]),
      ),
    [runs],
  );
}

/** The scenario the original Trial reached, from whatever the console has loaded. */
function loadedScenario(
  queryClient: ReturnType<typeof useQueryClient>,
  originalId: string,
): string | undefined {
  const listed = queryClient
    .getQueriesData<TrialList>({ queryKey: ["trials"] })
    .flatMap(([, list]) => list?.trials ?? [])
    .find((trial) => trial._id === originalId);
  if (listed) return listed.testScenario;
  return queryClient
    .getQueriesData<TrialDetail>({ queryKey: ["trial"] })
    .map(([, detail]) => detail?.history?.original)
    .find((original) => original?.id === originalId)?.testScenario;
}

function FinishedToastBody({
  run,
  answer,
  originalScenario,
}: {
  run: RetryRun;
  answer: FinishedRetry;
  originalScenario: string | undefined;
}) {
  const { success, testScenario, error } = answer.result ?? {};
  const changed = originalScenario && originalScenario !== testScenario;
  return (
    <>
      <b className="text-foreground">{run.name}</b>, {panoramaModeText(run.panoramaMode)}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <ModuleBadge status={success ? "pass" : "fail"} label={success ? "Answered" : "Failed"} />
        <span className={changed ? "text-amber-700" : undefined}>
          {testScenario || "no scenario"}
          {changed && ` (was ${originalScenario})`}
        </span>
      </div>
      {error && <div className="mt-1">{error}</div>}
    </>
  );
}

interface Retries {
  availability: RetryAvailability;
  /** Asks before spending money, then runs the retry. Resolves whether it was confirmed. */
  askToRetry: (
    target: RetryTarget,
    panoramaMode: PanoramaMode,
    returnFocusTo?: HTMLElement | null,
  ) => Promise<boolean>;
}

const RetriesContext = createContext<Retries>({
  availability: RETRIES_ON,
  askToRetry: async () => false,
});

export const useRetryAvailability = () => useContext(RetriesContext).availability;
export const useAskToRetry = () => useContext(RetriesContext).askToRetry;

interface Confirmation {
  target: RetryTarget;
  panoramaMode: PanoramaMode;
  answer: (confirmed: boolean) => void;
}

/**
 * Starts, resumes and reports retries for the Trials pages, so a retry outlives
 * the row or detail it was started from. A retry stays pending in the mutation
 * cache until it has a final answer, and the rest of the page reads it from there.
 */
export function RetriesProvider({
  availability,
  children,
}: {
  availability: RetryAvailability;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const runButton = useRef<HTMLButtonElement>(null);
  // Outlives the confirmation, which is gone by the time the dialog hands focus back.
  const returnFocus = useRef<HTMLElement | null | undefined>(undefined);

  const askToRetry = useCallback<Retries["askToRetry"]>(
    (target, panoramaMode, returnFocusTo) =>
      new Promise((resolve) => {
        returnFocus.current = returnFocusTo;
        setConfirmation({ target, panoramaMode, answer: resolve });
      }),
    [],
  );

  // These callbacks are on the mutation itself, so each retry reports even
  // after a later one has started or this page has gone.
  const { mutate } = useMutation({
    mutationKey: RETRY_KEY,
    // A retry that can't reach the server is sent again rather than paused.
    networkMode: "always",
    mutationFn: (run: RetryRun) => sendUntilAnswered(run, (data) => retryTrial({ data })),
    onMutate: (run) => {
      savePendingRetry(run);
    },
    onSuccess: (answer, run) => {
      const { trialId } = answer;
      showToast({
        title: "Retry finished",
        body: (
          <FinishedToastBody
            run={run}
            answer={answer}
            originalScenario={loadedScenario(queryClient, run.originalId)}
          />
        ),
        action: trialId
          ? (close) => (
              <TrialLink
                trialId={trialId}
                hash={RETRY_HISTORY_HASH}
                onClick={close}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                Open history
              </TrialLink>
            )
          : undefined,
      });
    },
    onError: (error, run) => {
      // Only a retired original panorama is fixed by a fresh one. Other refusals,
      // and Street View being unreachable, would stop a fresh retry too.
      const offerFresh =
        run.panoramaMode === "original" &&
        error instanceof RetryRefused &&
        error.code === "original_panorama_retired";
      showToast({
        failed: true,
        title: "Retry did not run",
        body: (
          <>
            <b className="text-foreground">{run.name}</b>, {panoramaModeText(run.panoramaMode)}
            <div className="mt-1">{error.message}</div>
          </>
        ),
        action: offerFresh
          ? (close) => (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void askToRetry(run, "fresh").then((confirmed) => {
                    if (confirmed) close();
                  });
                }}
              >
                Retry with fresh panorama
              </Button>
            )
          : undefined,
      });
    },
    onSettled: (_answer, _error, run) => {
      forgetPendingRetry(run.originalId);
      void queryClient.invalidateQueries({ queryKey: ["trials"] });
      void queryClient.invalidateQueries({
        queryKey: ["trial"],
        predicate: isTrialRunsQuery,
      });
    },
  });

  const isRunning = useCallback(
    (originalId: string) =>
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: RETRY_KEY, status: "pending" })
        .some((mutation) => runOf(mutation).originalId === originalId),
    [queryClient],
  );

  // Picks up retries a reload interrupted, under the keys they were first sent with.
  useEffect(() => {
    for (const run of readPendingRetries()) {
      if (!isRunning(run.originalId)) mutate(run);
    }
  }, [isRunning, mutate]);

  const finishConfirming = (confirmed: boolean) => {
    if (!confirmation) return;
    confirmation.answer(confirmed);
    if (confirmed && !isRunning(confirmation.target.originalId)) {
      mutate({
        ...confirmation.target,
        key: newIdempotencyKey(),
        panoramaMode: confirmation.panoramaMode,
        startedAt: Date.now(),
      });
    }
    setConfirmation(undefined);
  };

  const value = useMemo(() => ({ availability, askToRetry }), [availability, askToRetry]);

  return (
    <RetriesContext value={value}>
      {children}
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) finishConfirming(false);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-sm"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            runButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (!returnFocus.current) return;
            event.preventDefault();
            returnFocus.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription className="sr-only">
              This retry runs the current pipeline with paid API calls.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button ref={runButton} onClick={() => finishConfirming(true)}>
              Run retry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Toaster />
    </RetriesContext>
  );
}
