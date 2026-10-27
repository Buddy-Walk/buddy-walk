import axios from 'axios';
import type { LastMetersSensors } from '../utils/lastMetersSafety';
import { apiClient } from './client';
import { withNetworkRetry } from './retry';

/** A normal Last Meters answer takes seconds; past this the user should get the app back. */
export const LAST_METERS_TIMEOUT_MS = 60_000;

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
  signal?: AbortSignal
): Promise<{
  output?: string;
  error?: string;
  testLogId?: string;
  mode?: 'approach' | 'exact' | 'aligned';
  warning?: string;
  safetyReasons?: string[];
  guidanceKind?: 'withheld' | 'orientation';
  targetHeading?: number | null;
  currentHeading?: number;
}> {
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
    return res.data as {
      output?: string;
      error?: string;
      testLogId?: string;
      mode?: 'approach' | 'exact' | 'aligned';
      warning?: string;
    };
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
