import { readFileSync } from "node:fs";

import { expect, test as base, type Page } from "@playwright/test";

// Every test fails on a page error or a logged one. The crash Close once had only
// showed as a console error, with the router's error page in place of the list.
export const test = base.extend<{ allowedErrors: RegExp[]; noErrors: void }>({
  allowedErrors: [[], { option: true }],
  noErrors: [
    async ({ page, allowedErrors }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await use();
      expect(errors.filter((error) => !allowedErrors.some((re) => re.test(error)))).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export const viewLink = (trialId: string) => `a[href^="/trials/${trialId}"]:text-is("View")`;

export const rowOf = (page: Page, trialId: string) =>
  page.getByRole("row").filter({ has: page.locator(viewLink(trialId)) });

/** mobile/server's address and token, which the local stack writes once it is up. */
export function stackEnv() {
  const env = Object.fromEntries(
    readFileSync(new URL("../.stack/env", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2) as [string, string]),
  );
  return { apiBase: env.API_BASE_URL, token: env.ADMIN_TOKEN };
}
