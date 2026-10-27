import axios from 'axios';
import type { LastMetersSensors } from '../utils/lastMetersSafety';
import { aiClient, apiClient } from './client';
import { withNetworkRetry } from './retry';
import { withBriefReplyInstruction } from '../utils/briefAiInstruction';
import { RequestData, NavRoute } from '../types';
import { appVersion, getInstallId, platform, sessionId } from '../utils/identity';
import { getConversationId } from '../utils/conversationSession';

export interface TextResponse {
  output: string;
  /** Optional structured walking route from the backend (used for distance sanity checks). */
  route?: NavRoute | null;
}

export async function sendTextRequest(data: RequestData): Promise<TextResponse | undefined> {
  if (!data.text.trim()) return undefined;
  try {
    const installId = await getInstallId();
    const payload: RequestData = {
      ...data,
      text: withBriefReplyInstruction(data.text),
      analytics: {
        ...data.analytics,
        installId,
        sessionId,
        conversationId: getConversationId(),
        platform,
        appVersion,
      },
    };
    const start = Date.now();
    // Render owns verified local routing. Text requests must never fall back to
    // the legacy AI host, even when location is unavailable.
    const res = await withNetworkRetry(() =>
      apiClient.post('/text', payload, { timeout: 120_000 })
    );
    console.log(`Text request completed in ${Date.now() - start}ms`);
    return res.data as TextResponse;
  } catch (e) {
    console.error('sendTextRequest error:', e);
    throw e;
  }
}
/** A normal Last Meters answer takes seconds; past this the user should get the app back. */
export const LAST_MILE_TIMEOUT_MS = 60_000;

export async function sendLastMileRequest(
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
        apiClient.post('/last-mile', data, {
          timeout: LAST_MILE_TIMEOUT_MS,
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
    console.error('sendLastMileRequest error:', error);
    const backendMessage = error?.response?.data?.error;
    if (typeof backendMessage === 'string' && backendMessage.trim()) {
      throw new Error(backendMessage);
    }
    throw error;
  }
}
export async function sendAudioRequest(text: string): Promise<ArrayBuffer | undefined> {
  if (!text.trim()) return undefined;
  try {
    const res = await aiClient.post('/audio', { text }, { responseType: 'arraybuffer' });
    return res.data;
  } catch (directError) {
    console.warn('sendAudioRequest: direct AI host failed, falling back to Render', directError);
    try {
      const res = await apiClient.post('/audio', { text }, { responseType: 'arraybuffer' });
      return res.data;
    } catch (e) {
      console.error('sendAudioRequest error:', e);
      throw e;
    }
  }
}
