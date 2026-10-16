import axios from 'axios';
import { API_ROOT } from './client';

/**
 * Allow retries for transient connection, throttling, and gateway failures while preserving
 * cancellation and the caller's timeout policy.
 */
function isRetryableAxiosError(error: unknown, retryOnTimeout: boolean): boolean {
  if (axios.isCancel(error)) return false;
  if (!axios.isAxiosError(error)) return false;
  if (error.code === 'ECONNABORTED') return retryOnTimeout;
  if (!error.response) return true;
  if (error.message === 'Network Error') return true;
  const status = error.response.status;
  return status === 408 || status === 429 || (status >= 502 && status <= 504);
}

/** Wake the Render free-tier service before the first real API call. */
export async function warmApiBackend(): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await axios.get<{ ok?: boolean }>(`${API_ROOT}/api/health`, {
        timeout: 90_000,
      });
      if (res.data?.ok) return;
    } catch {
      // Cold starts on Render free tier can take ~60s.
    }
    if (attempt < maxAttempts - 1) {
      await new Promise(/* Wait longer between health checks while a cold backend is waking up. */ (resolve) => setTimeout(resolve, 15_000 * (attempt + 1)));
    }
  }
}

/**
 * Repeat a caller-supplied request within a bounded retry budget, optionally warming the backend
 * and applying incremental delays; throw the final error.
 */
export async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  options?: {
    retries?: number;
    baseDelayMs?: number;
    /** Retry after a client timeout. Off for slow requests, where a retry just doubles the wait. */
    retryOnTimeout?: boolean;
    /** Wait for the backend health check before retrying a connection failure. */
    warmOnFailure?: boolean;
  }
): Promise<T> {
  const retries = options?.retries ?? 2;
  const baseDelayMs = options?.baseDelayMs ?? 2000;
  const retryOnTimeout = options?.retryOnTimeout ?? true;
  const warmOnFailure = options?.warmOnFailure ?? true;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableAxiosError(error, retryOnTimeout) || attempt === retries) {
        throw error;
      }
      await new Promise(/* Apply the next retry delay without blocking the JavaScript event loop. */ (resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
      if (warmOnFailure && (!axios.isAxiosError(error) || !error.response)) {
        await warmApiBackend();
      }
    }
  }

  throw lastError;
}
