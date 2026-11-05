import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vite-plus/test";

import { secretNames, secretStatus } from "./secrets";

const readProjectFile = (name: string) =>
  readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");

describe("secretNames", () => {
  it("matches the secrets wrangler.jsonc requires", () => {
    const wrangler = parse(readProjectFile("wrangler.jsonc"));
    expect(wrangler.secrets.required).toEqual([...secretNames]);
  });

  it("matches the names in .env.example", () => {
    expect(Object.keys(parseEnv(readProjectFile(".env.example")))).toEqual([...secretNames]);
  });
});

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
