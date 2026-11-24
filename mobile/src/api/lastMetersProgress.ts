import {
  LAST_METERS_PROGRESS_CONTENT_TYPE, isLastMetersModule, type LastMetersProgressEvent,
} from '../utils/lastMetersProgress';

type FetchProgress = (url: string, init: RequestInit) => Promise<Pick<Response, 'headers' | 'body' | 'json' | 'status'>>;

function responseBody(status: number, body: unknown): Record<string, unknown> {
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (status >= 200 && status < 300) return fields;
  throw new Error(typeof fields.error === 'string' && fields.error.trim()
    ? fields.error
    : `Request failed with status code ${status}`);
}

async function readProgress(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onProgress: (event: LastMetersProgressEvent) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('Last Meters request was cancelled.');
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (done) lines.push(pending);
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event?.type === 'module_started' && isLastMetersModule(event.module)) {
          onProgress({ type: 'module_started', module: event.module });
        } else if (event?.type === 'result' && Number.isInteger(event.status) &&
          event.status >= 200 && event.status <= 599 && event.body &&
          typeof event.body === 'object' && !Array.isArray(event.body)) {
          return responseBody(event.status, event.body);
        }
      }
      if (done) throw new Error('The Last Meters connection ended before a result. Please try again.');
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Request and consume one response. A JSON fallback comes from the same POST. */
export async function requestLastMetersProgress(
  fetcher: FetchProgress,
  url: string,
  data: object,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onProgress: (event: LastMetersProgressEvent) => void,
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    if (signal?.aborted) throw new Error('Last Meters request was cancelled.');
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: LAST_METERS_PROGRESS_CONTENT_TYPE + ', application/json',
      },
      signal: controller.signal,
      body: JSON.stringify(data),
    });
    const contentType = response.headers.get('content-type')?.split(';')[0].trim();
    if (contentType === LAST_METERS_PROGRESS_CONTENT_TYPE && response.body) {
      return await readProgress(response.body, controller.signal, onProgress);
    }
    // Legacy services and the upstream text proxy still send their usual JSON.
    const body = await response.json().catch(() => undefined);
    if (!body && response.status >= 200 && response.status < 300) {
      throw new Error('The Last Meters response could not be read. Please try again.');
    }
    return responseBody(response.status, body);
  } catch (error) {
    if (timedOut) throw Object.assign(new Error('Last Meters timed out.'), { code: 'ECONNABORTED' });
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
