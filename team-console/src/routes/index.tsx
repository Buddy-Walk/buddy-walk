import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { secretNames } from "#/lib/secrets";
import { secretStatusQuery } from "#/server/secrets";

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(secretStatusQuery),
  component: Home,
});

function Home() {
  const { data: status } = useSuspenseQuery(secretStatusQuery);

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-semibold">Team console</h1>
      <p className="mt-2 text-muted-foreground">Trials and usage will live here.</p>
      <h2 className="mt-8 text-lg font-medium">Secrets</h2>
      <ul className="mt-2 space-y-1">
        {secretNames.map((name) => (
          <li key={name} className="flex justify-between rounded-md border px-3 py-2">
            <code>{name}</code>
            <span className={status[name] ? "text-foreground" : "text-destructive"}>
              {status[name] ? "set" : "missing"}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
