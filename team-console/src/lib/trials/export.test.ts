import { describe, expect, it } from "vite-plus/test";

import { exportHref, parseExportParams, viewParams } from "./export";

const paramsOf = (search: string) => parseExportParams(new URLSearchParams(search));

describe("viewParams", () => {
  it("sends the limit and leaves includeRetries out when off", () => {
    expect(viewParams({ limit: 200, includeRetries: false })).toEqual({ limit: "200" });
  });

  it("sends includeRetries when on", () => {
    expect(viewParams({ limit: 50, includeRetries: true })).toEqual({
      limit: "50",
      includeRetries: "true",
    });
  });
});

describe("exportHref", () => {
  it("points at the console's own route with the view's limit and retries", () => {
    expect(exportHref({ limit: 50, includeRetries: true })).toBe(
      "/api/trials/export.csv?limit=50&includeRetries=true",
    );
  });

  it("never carries a token", () => {
    expect(exportHref({ limit: 200, includeRetries: false })).toBe(
      "/api/trials/export.csv?limit=200",
    );
  });
});

describe("parseExportParams", () => {
  it("reads what exportHref writes", () => {
    expect(paramsOf("limit=50&includeRetries=true")).toEqual({ limit: 50, includeRetries: true });
    expect(paramsOf("limit=200")).toEqual({ limit: 200, includeRetries: false });
  });

  it.each(["", "limit=", "limit=0", "limit=2.5", "limit=501", "limit=abc"])(
    "rejects %j",
    (search) => {
      expect(paramsOf(search)).toBeUndefined();
    },
  );
});
