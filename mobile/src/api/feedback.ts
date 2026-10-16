import { apiClient } from './client';
import { appVersion, getInstallId, platform, sessionId } from '../utils/identity';

export type FeedbackType = 'general' | 'answer_rating' | 'bug';

export interface FeedbackInput {
  type: FeedbackType;
  /** 1-5 star rating, or 1/-1 for a thumbs up/down on an answer. */
  rating?: number;
  message?: string;
  /** Free-form, PII-free context (screen, related question, etc.). */
  context?: Record<string, string | number | boolean | null>;
}

/**
 * Submit a feedback report with installation and session metadata; return undefined when the
 * optional request fails.
 */
export async function submitFeedback(input: FeedbackInput) {
  try {
    const installId = await getInstallId();
    const result = await apiClient.post('/feedback', {
      ...input,
      installId,
      sessionId,
      platform,
      appVersion,
    });
    return result.data;
  } catch (e) {
    console.error('submitFeedback error:', e);
    return undefined;
  }
}
