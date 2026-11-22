import { createFileRoute } from "@tanstack/react-router";

import { parseDateRange, rangeParams, usageExport } from "#/lib/usage/export";
import { callApi } from "#/server/api";

// A route rather than a server function, so the browser can download it from a link.
export const Route = createFileRoute("/api/usage/$file")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const target = usageExport(params.file);
        if (!target) return new Response("No such export.", { status: 404 });

        const range = parseDateRange(new URL(request.url).searchParams);
        if (!range) return new Response("The export needs valid dates.", { status: 400 });

        try {
          const csv = await callApi(target.path, { params: rangeParams(range) });
          return new Response(csv.body, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="${target.filename}"`,
            },
          });
        } catch (error) {
          return new Response(`Could not export ${params.file}. ${(error as Error).message}`, {
            status: 502,
          });
        }
      },
    },
  },
});
