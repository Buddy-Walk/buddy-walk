import { createFileRoute } from "@tanstack/react-router";

import { parseExportParams, viewParams } from "#/lib/trials/export";
import { callApi } from "#/server/api";

// A route rather than a server function, so the browser can download it from a link.
export const Route = createFileRoute("/api/trials/export.csv")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const view = parseExportParams(new URL(request.url).searchParams);
        if (!view) return new Response("The export needs a valid limit.", { status: 400 });

        try {
          const csv = await callApi("/api/last-meters-tests/export.csv", {
            params: viewParams(view),
          });
          return new Response(csv.body, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": 'attachment; filename="last_meters_tests.csv"',
            },
          });
        } catch (error) {
          return new Response(`Could not export Trials. ${(error as Error).message}`, {
            status: 502,
          });
        }
      },
    },
  },
});
