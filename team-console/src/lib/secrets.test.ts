import { describe, expect, it } from "vite-plus/test";

import { secretStatus } from "./secrets";

describe("secretStatus", () => {
  it("reports each secret as set or missing", () => {
    expect(secretStatus({ ADMIN_TOKEN: "abc" })).toEqual({
      ADMIN_TOKEN: true,
      API_BASE_URL: false,
    });
  });

  it("treats a blank value as missing", () => {
    expect(secretStatus({ ADMIN_TOKEN: "  ", API_BASE_URL: "" })).toEqual({
      ADMIN_TOKEN: false,
      API_BASE_URL: false,
    });
  });

  it("never returns the values", () => {
    const status = secretStatus({ ADMIN_TOKEN: "abc", API_BASE_URL: "https://api.example" });
    expect(JSON.stringify(status)).not.toMatch(/abc|api\.example/);
  });
});
