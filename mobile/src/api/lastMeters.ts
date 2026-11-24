import axios from 'axios';
import { fetch as expoFetch } from 'expo/fetch';
import type { LastMetersProgressEvent } from '../utils/lastMetersProgress';
import { requestLastMetersProgress } from './lastMetersProgress';
import type { LastMetersSensors } from '../utils/lastMetersSafety';
import { API_ROOT, apiClient } from './client';
import { withNetworkRetry } from './retry';

/** A normal Last Meters answer takes seconds; past this the user should get the app back. */
export const LAST_METERS_TIMEOUT_MS = 60_000;

interface LastMetersResponse {
  output?: string;
  error?: string;
  testLogId?: string;
  mode?: 'approach' | 'exact' | 'aligned';
  warning?: string;
  safetyReasons?: string[];
  guidanceKind?: 'withheld' | 'orientation';
  targetHeading?: number | null;
  currentHeading?: number;
}

export async function sendLastMetersRequest(
  data: {
    lat: number;
    lng: number;
    gpsAccuracyMeters?: number;
    heading?: number;
    compassAccuracyLevel?: number;
    image: string;
    destination: string;
    sensors?: LastMetersSensors;
  },
  signal?: AbortSignal,
  onProgress?: (event: LastMetersProgressEvent) => void,
): Promise<LastMetersResponse> {
  if (onProgress && typeof ReadableStream !== 'undefined') {
    return requestLastMetersProgress(expoFetch, `${API_ROOT}/api/last-meters`, data,
      signal, LAST_METERS_TIMEOUT_MS, onProgress);
  }

  // Last Meters hits Render; when Maps+OpenAI keys are absent it is rewritten to
  // buddywalk.app /api/text upstream.
  try {
    const res = await withNetworkRetry(
      () =>
        apiClient.post('/last-meters', data, {
          timeout: LAST_METERS_TIMEOUT_MS,
          signal,
        }),
      { retries: 1, retryOnTimeout: false, warmOnFailure: false }
    );
    return res.data as LastMetersResponse;
  } catch (error: any) {
    if (axios.isCancel(error)) throw error;
    console.error('sendLastMetersRequest error:', error);
    const backendMessage = error?.response?.data?.error;
    if (typeof backendMessage === 'string' && backendMessage.trim()) {
      throw new Error(backendMessage);
    }
    throw error;
  }
}
