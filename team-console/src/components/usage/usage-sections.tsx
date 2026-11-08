import type { ReactNode } from "react";

import { Card, CardContent } from "#/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { formatDate } from "#/lib/trials/display";
import { feedbackRating, summaryCards, withBars } from "#/lib/usage/display";
import type { Feedback, TelemetrySummary } from "#/lib/usage/schema";

/** What a table shows while it has no rows of its own to show. */
export interface TableMessages {
  loading: boolean;
  failed: boolean;
  empty: string;
}

const messageFor = ({ loading, failed, empty }: TableMessages) =>
  failed ? "Failed to load data." : loading ? "Loading..." : empty;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="border-b pb-2 font-medium">{title}</h2>
      {children}
    </section>
  );
}

function MessageRow({ columns, message }: { columns: number; message: string }) {
  return (
    <TableRow>
      <TableCell colSpan={columns} className="text-muted-foreground">
        {message}
      </TableCell>
    </TableRow>
  );
}

export function UsageCards({ summary }: { summary: TelemetrySummary }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4">
      {summaryCards(summary).map(({ label, value }) => (
        <Card key={label} className="py-4">
          <CardContent className="px-4">
            <div className="text-3xl font-bold">{value}</div>
            <div className="mt-1 text-sm text-muted-foreground">{label}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function BarSection({
  title,
  nameLabel,
  rows,
  messages,
}: {
  title: string;
  nameLabel: string;
  rows: { name: string; count: number }[];
  messages: TableMessages;
}) {
  return (
    <Section title={title}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{nameLabel}</TableHead>
            <TableHead>Count</TableHead>
            <TableHead className="w-2/5" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length ? (
            withBars(rows).map(({ name, count, percent }) => (
              <TableRow key={name}>
                <TableCell>{name}</TableCell>
                <TableCell className="tabular-nums">{count}</TableCell>
                <TableCell>
                  <div className="h-2 rounded-sm bg-primary" style={{ width: `${percent}%` }} />
                </TableCell>
              </TableRow>
            ))
          ) : (
            <MessageRow columns={3} message={messageFor(messages)} />
          )}
        </TableBody>
      </Table>
    </Section>
  );
}

export function AiRequestsSection({
  rows,
  loading,
  failed,
}: {
  rows: TelemetrySummary["aiRequests"]["byFeature"];
  loading: boolean;
  failed: boolean;
}) {
  return (
    <Section title="AI requests (server-side)">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Feature</TableHead>
            <TableHead>Requests</TableHead>
            <TableHead>Avg latency (ms)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length ? (
            rows.map(({ feature, count, avgLatencyMs }) => (
              <TableRow key={feature}>
                <TableCell>{feature}</TableCell>
                <TableCell className="tabular-nums">{count}</TableCell>
                <TableCell className="tabular-nums">{avgLatencyMs}</TableCell>
              </TableRow>
            ))
          ) : (
            <MessageRow
              columns={3}
              message={messageFor({ loading, failed, empty: "No AI request logs yet." })}
            />
          )}
        </TableBody>
      </Table>
    </Section>
  );
}

export function FeedbackSection({
  feedback,
  loading,
  failed,
}: {
  feedback: Feedback[];
  loading: boolean;
  failed: boolean;
}) {
  return (
    <Section title="Recent feedback">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Rating</TableHead>
            <TableHead>Message</TableHead>
            <TableHead>Version</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {feedback.length ? (
            feedback.map((entry, index) => (
              <TableRow key={index}>
                <TableCell className="align-top">{formatDate(entry.date)}</TableCell>
                <TableCell className="align-top">{entry.type}</TableCell>
                <TableCell className="align-top">{feedbackRating(entry)}</TableCell>
                <TableCell className="align-top whitespace-normal">{entry.message}</TableCell>
                <TableCell className="align-top text-muted-foreground">
                  {entry.appVersion}
                </TableCell>
              </TableRow>
            ))
          ) : (
            <MessageRow
              columns={5}
              message={messageFor({ loading, failed, empty: "No feedback yet." })}
            />
          )}
        </TableBody>
      </Table>
    </Section>
  );
}
