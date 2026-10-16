import axios from 'axios';
import { API_ROOT, COMPANION_API_ROOT } from './client';

/**
 * Turn HTTP and connection failures into actionable backend setup messages, choosing the companion
 * or main API address for the affected feature.
 */
export function describeApiError(error: unknown, feature = 'request'): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 404 && feature === 'companion') {
      return (
        `Companion API is missing on ${COMPANION_API_ROOT} (404).\n\n` +
        `Run npm run serve in mobile/ and set EXPO_PUBLIC_COMPANION_API_URL to that machine's LAN IP ` +
        `(e.g. http://192.168.x.x:8000). Q&A uses ${API_ROOT}.`
      );
    }
    if (!error.response) {
      return (
        `Cannot reach the backend at ${feature === 'companion' ? COMPANION_API_ROOT : API_ROOT}.\n\n` +
        `Check same Wi-Fi, firewall, and ${feature === 'companion' ? 'EXPO_PUBLIC_COMPANION_API_URL' : 'EXPO_PUBLIC_API_URL'} in mobile/.env (LAN IP, not localhost).`
      );
    }
    const data = error.response.data as { error?: string } | string | undefined;
    const detail =
      typeof data === 'object' && data && 'error' in data && typeof data.error === 'string'
        ? data.error
        : typeof data === 'string'
          ? data
          : '';
    return detail || error.message || `Request failed (${status ?? 'unknown'})`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
