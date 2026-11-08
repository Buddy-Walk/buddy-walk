import { describe, expect, it } from "vite-plus/test";

import {
  parseDateRange,
  rangeParams,
  usageExport,
  usageExportHref,
  usageSearchSchema,
} from "./export";

const rangeOf = (search: string) => parseDateRange(new URLSearchParams(search));

describe("usageSearchSchema", () => {
  it("keeps the dates of a shared link", () => {
    expect(usageSearchSchema.parse({ since: "2026-11-01", until: "2026-11-08" })).toEqual({
      since: "2026-11-01",
      until: "2026-11-08",
    });
  });

  it("drops a date it can't read, so an edited link still opens", () => {
    expect(usageSearchSchema.parse({ since: "soon", until: "2026-11-08" })).toEqual({
      until: "2026-11-08",
    });
  });
});

describe("rangeParams", () => {
  it("sends only the dates that are set", () => {
    expect(rangeParams({})).toEqual({});
    expect(rangeParams({ since: "2026-11-01" })).toEqual({ since: "2026-11-01" });
  });
});

describe("usageExportHref", () => {
  it("points at the console's own route with the applied dates and no token", () => {
    expect(usageExportHref("events.csv", { since: "2026-11-01", until: "2026-11-08" })).toBe(
      "/api/usage/events.csv?since=2026-11-01&until=2026-11-08",
    );
  });

  it("has no query without dates", () => {
    expect(usageExportHref("chat-logs.csv", {})).toBe("/api/usage/chat-logs.csv");
  });
});

describe("usageExport", () => {
  it.each([
    ["events.csv", "/api/telemetry/events.csv", "telemetry_events.csv"],
    ["ai-requests.csv", "/api/telemetry/ai-requests.csv", "ai_requests.csv"],
    ["feedback.csv", "/api/feedback/export.csv", "feedback.csv"],
    ["chat-logs.csv", "/api/db/chatlogs.csv", "chat_logs.csv"],
  ])("sends %s to mobile/server's export and keeps its file name", (file, path, filename) => {
    expect(usageExport(file)).toEqual({ path, filename });
  });

  it.each(["", "users.csv", "toString", "__proto__"])("knows nothing of %j", (file) => {
    expect(usageExport(file)).toBeUndefined();
  });
});

describe("parseDateRange", () => {
  it("reads what usageExportHref writes", () => {
    expect(rangeOf("since=2026-11-01&until=2026-11-08")).toEqual({
      since: "2026-11-01",
      until: "2026-11-08",
    });
    expect(rangeOf("")).toEqual({});
  });

  // A bad date must not quietly export everything.
  it.each(["since=soon", "until=2026-13-40", "since="])("rejects %j", (search) => {
    expect(rangeOf(search)).toBeUndefined();
  });

  it("forwards nothing but the two dates", () => {
    expect(rangeOf("since=2026-11-01&token=abc&limit=9")).toEqual({ since: "2026-11-01" });
  });
});
