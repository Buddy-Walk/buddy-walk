import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, stripSearchParams } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";

import { TrialsFilters } from "#/components/trials/trials-filters";
import { TrialsSummaryCards } from "#/components/trials/trials-summary";
import { TrialsTable } from "#/components/trials/trials-table";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
  DEFAULT_LIMIT,
  trialsSearchSchema,
  viewTrials,
  type TrialsSearch,
} from "#/lib/trials/filters";
import { trialsQuery } from "#/server/trials";

export const Route = createFileRoute("/trials")({
  validateSearch: trialsSearchSchema,
  search: {
    middlewares: [stripSearchParams({ limit: DEFAULT_LIMIT, includeRetries: false })],
  },
  // Filters other than these apply to the loaded Trials, so they don't reload the list.
  loaderDeps: ({ search: { limit, includeRetries } }) => ({ limit, includeRetries }),
  // prefetchQuery never throws, so a failed load shows above the table as it did on the old page.
  loader: ({ context, deps }) => context.queryClient.prefetchQuery(trialsQuery(deps)),
  // Times and weeks are in the reader's locale and time zone, which the Worker
  // doesn't know, so the server loads the data and the browser renders it.
  ssr: "data-only",
  head: () => ({ meta: [{ title: "Trials · Team console" }] }),
  component: TrialsPage,
});

function TrialsPage() {
  const search = Route.useSearch();
  const deps = Route.useLoaderDeps();
  const navigate = Route.useNavigate();
  const trials = useQuery({ ...trialsQuery(deps), placeholderData: keepPreviousData });

  const view = useMemo(
    () => (trials.data ? viewTrials(trials.data, search) : undefined),
    [trials.data, search],
  );

  // Filter changes replace the history entry, so back leaves the list rather than undoing a filter.
  const updateSearch = (patch: Partial<TrialsSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true, resetScroll: false });

  return (
    <>
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 border-b bg-background px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Last Meters Trials</h1>
          <p className="text-xs text-muted-foreground">
            Review pipeline modules, confidence fusion, and evaluate visual alignment.
          </p>
        </div>
        <Button variant="outline" onClick={() => trials.refetch()} disabled={trials.isFetching}>
          <RefreshCwIcon className={trials.isFetching ? "animate-spin" : undefined} />
          Refresh
        </Button>
      </header>

      <main className="mx-auto flex max-w-[1440px] flex-col gap-5 p-6">
        <TrialsFilters search={search} onChange={updateSearch} />

        <p className="text-sm text-muted-foreground" aria-live="polite">
          {view && trials.data
            ? `${
                view.shown.length === trials.data.length
                  ? view.shown.length
                  : `${view.shown.length} of ${trials.data.length}`
              } Trial${trials.data.length === 1 ? "" : "s"} shown - updated ${new Date(
                trials.dataUpdatedAt,
              ).toLocaleTimeString()}`
            : trials.isPending
              ? "Loading..."
              : null}
        </p>

        {trials.isError && (
          <Alert variant="destructive">
            <AlertDescription className="whitespace-pre-wrap">
              Could not load Trials. Check the token and logs. {trials.error.message}
            </AlertDescription>
          </Alert>
        )}

        {view && <TrialsSummaryCards summary={view.summary} />}

        <TrialsTable
          trials={view?.shown ?? []}
          message={
            trials.isError ? "Failed to load data." : trials.isPending ? "Loading..." : undefined
          }
        />
      </main>

      <Outlet />
    </>
  );
}
