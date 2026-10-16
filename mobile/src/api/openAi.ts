import axios from 'axios';
import type { LastMileSensors } from '../utils/lastMileSafety';
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

/**
 * Send a text or photo question to the owned API with conversation and telemetry context; return
 * no request for blank input and propagate request failures.
 */
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
    const res = await withNetworkRetry(/* Issue one text request attempt with the longer timeout required by multimodal answers. */ () =>
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

/**
 * Submit a Last Meters photo with its original sensor evidence to the mobile API, preserving
 * cancellation and surfacing a useful backend error message.
 */
export async function sendLastMileRequest(
  data: {
    lat: number;
    lng: number;
    gpsAccuracyMeters?: number;
    heading?: number;
    compassAccuracyLevel?: number;
    image: string;
    destination: string;
    sensors?: LastMileSensors;
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
}> {
  // Last Meters hits Render; when Maps+OpenAI keys are absent it is rewritten to
  // buddywalk.app /api/text upstream.
  try {
    const res = await withNetworkRetry(
      /** Issue one cancellable Last Meters request using the photo's original sensor snapshot. */
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
/**
 * Request synthesized MP3 speech, trying the direct speech host first and the owned backend if
 * that request fails.
 */
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
