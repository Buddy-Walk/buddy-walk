import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import type { SuccessGroup, TrialsSummary } from "#/lib/trials/summary";

function SummaryCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-sm">{children}</CardContent>
    </Card>
  );
}

function SuccessTable({ groups, keyLabel }: { groups: SuccessGroup[]; keyLabel: string }) {
  if (!groups.length) {
    return <p className="text-xs text-muted-foreground">No scored Trials yet.</p>;
  }
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-muted-foreground">
        <tr>
          <th className="py-1 pr-2 font-semibold">{keyLabel}</th>
          <th className="py-1 pr-2 font-semibold">Scored</th>
          <th className="py-1 pr-2 font-semibold">Got there</th>
          <th className="py-1 font-semibold">Rate</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <tr key={group.label} className="border-t">
            <td className="py-1 pr-2">{group.label}</td>
            <td className="py-1 pr-2 tabular-nums">{group.scored}</td>
            <td className="py-1 pr-2 tabular-nums">{group.success}</td>
            <td className="py-1 tabular-nums">{group.rate}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TrialsSummaryCards({ summary }: { summary: TrialsSummary }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
      <SummaryCard title="Success rate (scored Trials)">
        <div className="text-3xl font-extrabold">
          {summary.rate === null ? "-" : `${summary.rate}%`}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {summary.scored} of {summary.trials} Trials scored. Success means the reviewer chose
          "Would get me there".
        </p>
      </SummaryCard>
      <SummaryCard title="By week">
        <SuccessTable groups={summary.byWeek} keyLabel="Week" />
      </SummaryCard>
      <SummaryCard title="By location">
        <SuccessTable groups={summary.byLocation} keyLabel="Location" />
      </SummaryCard>
      <SummaryCard title="By pipeline version">
        <SuccessTable groups={summary.byVersion} keyLabel="Version" />
      </SummaryCard>
      <SummaryCard title="Field errors">
        <p>
          Wrong turns: {summary.wrongTurns.wrong} / {summary.wrongTurns.scored} scored
        </p>
        <p className="mt-2">
          Wrong entrances: {summary.wrongEntrances.wrong} / {summary.wrongEntrances.scored} scored
        </p>
      </SummaryCard>
    </div>
  );
}
