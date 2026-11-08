import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";

import { UsageFilters } from "#/components/usage/usage-filters";
import {
  AiRequestsSection,
  BarSection,
  FeedbackSection,
  UsageCards,
} from "#/components/usage/usage-sections";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button, buttonVariants } from "#/components/ui/button";
import {
  usageExportHref,
  usageSearchSchema,
  type DateRange,
  type UsageExportFile,
} from "#/lib/usage/export";
import { feedbackQuery, telemetrySummaryQuery } from "#/server/usage";

export const Route = createFileRoute("/usage")({
  validateSearch: usageSearchSchema,
  loaderDeps: ({ search: { since, until } }) => ({ since, until }),
  // prefetchQuery never throws, so a failed load shows beside the controls.
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.prefetchQuery(telemetrySummaryQuery(deps)),
      context.queryClient.prefetchQuery(feedbackQuery),
    ]),
  // Times are in the reader's locale and time zone, which the Worker doesn't know.
  ssr: "data-only",
  head: () => ({ meta: [{ title: "Usage · Team console" }] }),
  component: UsagePage,
});

const EXPORT_LINKS: { file: UsageExportFile; label: string }[] = [
  { file: "events.csv", label: "Events CSV" },
  { file: "ai-requests.csv", label: "AI Requests CSV" },
  { file: "feedback.csv", label: "Feedback CSV" },
  { file: "chat-logs.csv", label: "Chat Logs CSV" },
];

function UsagePage() {
  const range = Route.useLoaderDeps();
  const navigate = Route.useNavigate();
  const summary = useQuery({ ...telemetrySummaryQuery(range), placeholderData: keepPreviousData });
  const feedback = useQuery(feedbackQuery);
  const fetching = summary.isFetching || feedback.isFetching;

  const applyRange = (next: DateRange) =>
    navigate({ search: next, replace: true, resetScroll: false });
  const refresh = () => {
    void summary.refetch();
    void feedback.refetch();
  };

  const summaryState = { loading: summary.isPending, failed: summary.isError };

  return (
    <>
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 border-b bg-background px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Usage</h1>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {summary.dataUpdatedAt
              ? `Updated ${new Date(summary.dataUpdatedAt).toLocaleTimeString()}`
              : "Loading..."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={refresh} disabled={fetching}>
            <RefreshCwIcon className={fetching ? "animate-spin" : undefined} />
            Refresh
          </Button>
          {EXPORT_LINKS.map(({ file, label }) => (
            <a key={file} className={buttonVariants()} href={usageExportHref(file, range)}>
              {label}
            </a>
          ))}
        </div>
      </header>

      <main className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6">
        <UsageFilters range={range} onApply={applyRange} />

        {summary.isError && (
          <Alert variant="destructive">
            <AlertDescription className="whitespace-pre-wrap">
              Could not load the summary. Check the token and logs. {summary.error.message}
            </AlertDescription>
          </Alert>
        )}

        {summary.data && <UsageCards summary={summary.data} />}

        <div className="grid gap-6 lg:grid-cols-2">
          <BarSection
            title="Events by name"
            nameLabel="Event"
            rows={summary.data?.byEvent ?? []}
            messages={{ ...summaryState, empty: "No data yet." }}
          />
          <BarSection
            title="Feature usage (Q&A)"
            nameLabel="Feature"
            rows={
              summary.data?.byFeature.map(({ feature, count }) => ({ name: feature, count })) ?? []
            }
            messages={{ ...summaryState, empty: "No data yet." }}
          />
        </div>

        <AiRequestsSection rows={summary.data?.aiRequests.byFeature ?? []} {...summaryState} />

        <FeedbackSection
          feedback={feedback.data ?? []}
          loading={feedback.isPending}
          failed={feedback.isError}
        />
      </main>
    </>
  );
}
