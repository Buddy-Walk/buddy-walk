import { apiClient } from './client';
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
