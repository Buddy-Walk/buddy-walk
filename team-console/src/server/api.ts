import { env } from "cloudflare:workers";
import { z } from "zod";

interface ApiCall {
  params?: Record<string, string>;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Calls mobile/server as the team, for callers that read a failed response too.
 * ADMIN_TOKEN only ever travels in this header, never in a URL or to the browser.
 */
export async function fetchApi(
  path: string,
  { params = {}, ...init }: ApiCall = {},
): Promise<Response> {
  if (!env.API_BASE_URL) throw new Error("API_BASE_URL is not set for the Team console.");
  const url = new URL(path, env.API_BASE_URL);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  return fetch(url, {
    ...init,
    headers: { ...init.headers, ...(env.ADMIN_TOKEN ? { "x-admin-token": env.ADMIN_TOKEN } : {}) },
  });
}

/** Calls mobile/server as the team, throwing on a failed response. */
export async function callApi(path: string, call?: ApiCall): Promise<Response> {
  const response = await fetchApi(path, call);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

/**
 * Checks a response from mobile/server against its schema, so a change to the
 * fields mobile/server computes fails here.
 */
export async function parseResponse<T extends z.ZodType>(
  path: string,
  response: Response,
  schema: T,
): Promise<z.output<T>> {
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      `mobile/server's response to ${path} has an unexpected shape:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export async function getFromApi<T extends z.ZodType>(
  path: string,
  params: Record<string, string>,
  schema: T,
): Promise<z.output<T>> {
  return parseResponse(path, await callApi(path, { params }), schema);
}
