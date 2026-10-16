import { aiClient, apiClient } from './client';
import { withNetworkRetry } from './retry';

/**
 * Fetch live nearby arrivals for one subway line, falling back to the owned API and rejecting
 * responses without usable arrival text.
 */
export async function fetchMtaArrivals(
  routeId: string,
  latitude: number,
  longitude: number
): Promise<string> {
  let res;
  try {
    res = await aiClient.post('/mta', { routeId, lat: latitude, lon: longitude }, { timeout: 15_000 });
  } catch (directError) {
    console.warn('fetchMtaArrivals: direct AI host failed, falling back to Render', directError);
    res = await withNetworkRetry(/* Repeat the owned-backend MTA request when the network retry wrapper permits another attempt. */ () =>
      apiClient.post('/mta', { routeId, lat: latitude, lon: longitude }, { timeout: 30_000 })
    );
  }
  const data = res.data as { arrivals?: string; error?: string };
  if (typeof data.arrivals === 'string' && data.arrivals.trim()) {
    return data.arrivals.trim();
  }
  throw new Error(data.error ?? 'MTA lookup failed');
}
