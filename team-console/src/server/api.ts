import { env } from "cloudflare:workers";

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
