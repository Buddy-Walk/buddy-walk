import axios, { AxiosResponse } from 'axios';
import express, { Application, Request, Response } from 'express';
import { getUpstreamApiRoot, hasOwnAiKeys, canRunLocalLastMile } from '../config/serverMode';
import { aiRequestLogService } from '../services/aiRequestLog';
import {
  compressUserPhoto,
  lastMileTestLogService,
} from '../services/lastMileTestLog';

/** Convert a usable string to a bounded log value, omitting empty or nonstring input. */
function truncate(value: unknown, max = 800): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** Forward the caller's authorization header without copying unrelated inbound headers upstream. */
function pickForwardHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth) out.Authorization = auth;
  return out;
}

/** Extract readable answer text from the response shapes supported by the upstream API. */
function extractOutputText(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.output === 'string') return record.output;
  if (typeof record.message === 'string') return record.message;
  if (typeof record.text === 'string') return record.text;
  return undefined;
}

/**
 * Record bounded proxy input/output, image counts, status, and latency for usage review without
 * blocking the answer on logging.
 */
async function recordProxyMetrics(
  req: Request,
  upstreamRes: AxiosResponse,
  startedAt: number,
  feature: string
): Promise<void> {
  const body = req.body as Record<string, unknown> | undefined;
  const analytics = (body?.analytics ?? {}) as Record<string, unknown>;
  const inputText = truncate(body?.text);
  const outputText = truncate(extractOutputText(upstreamRes.data));
  const success = upstreamRes.status >= 200 && upstreamRes.status < 300;
  const images = Array.isArray(body?.image) ? body.image : [];

  await aiRequestLogService.record({
    requestId: typeof analytics.requestId === 'string' ? analytics.requestId : undefined,
    installId: typeof analytics.installId === 'string' ? analytics.installId : undefined,
    sessionId: typeof analytics.sessionId === 'string' ? analytics.sessionId : undefined,
    platform: typeof analytics.platform === 'string' ? analytics.platform : undefined,
    appVersion: typeof analytics.appVersion === 'string' ? analytics.appVersion : undefined,
    feature: typeof analytics.feature === 'string' ? analytics.feature : feature,
    inputLength: typeof body?.text === 'string' ? body.text.length : 0,
    inputText,
    outputText,
    hasImage: images.some(Boolean),
    imageCount: images.filter(Boolean).length,
    hasCoords: Boolean(body?.coords),
    success,
    errorCode: success ? undefined : String(upstreamRes.status),
    latencyMs: Date.now() - startedAt,
    outputLength: outputText?.length,
  });
}

type UpstreamResult = {
  status: number;
  data: unknown;
  contentType?: string;
};

/**
 * Send JSON to the configured upstream with a finite timeout while preserving error status bodies
 * for the caller.
 */
async function fetchUpstreamJson(req: Request, upstreamPath: string): Promise<UpstreamResult> {
  const upstreamRoot = getUpstreamApiRoot();
  const url = `${upstreamRoot}${upstreamPath}`;
  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && req.body !== undefined;

  const upstreamRes = await axios({
    method,
    url,
    ...(hasBody ? { data: req.body } : {}),
    headers: {
      Accept: 'application/json',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...pickForwardHeaders(req),
    },
    /**
     * Allow all upstream HTTP statuses through Axios so the proxy can preserve their response
     * bodies.
     */
    validateStatus: () => true,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120_000,
  });

  return {
    status: upstreamRes.status,
    data: upstreamRes.data,
    contentType:
      typeof upstreamRes.headers['content-type'] === 'string'
        ? upstreamRes.headers['content-type']
        : undefined,
  };
}

/** Copy the upstream status, content type, and response body into the HTTP response. */
function sendUpstreamResult(res: Response, result: UpstreamResult): void {
  res.status(result.status);
  if (result.contentType) {
    res.set('Content-Type', result.contentType);
  }
  res.send(result.data);
}

/**
 * Explain which server credentials or upstream configuration are needed when no AI route is
 * available.
 */
function upstreamUnavailableMessage(): Record<string, string> {
  return {
    error:
      'AI is unavailable on the upstream host (buddywalk.app). ' +
      'Add OPENAI_API_KEY or GEMINI_API_KEY in the Render dashboard for this service to run Q&A locally.',
  };
}

/**
 * Try the matching local AI controller when this deployment has credentials and the upstream
 * cannot answer.
 */
async function tryLocalAiHandler(
  req: Request,
  res: Response,
  handler: 'text' | 'parse' | 'audio'
): Promise<boolean> {
  if (!hasOwnAiKeys()) return false;
  const { OpenAIController } = await import('../controllers/openAI');
  const controller = new OpenAIController();
  if (handler === 'text') {
    await controller.textRequest(req, res);
  } else if (handler === 'parse') {
    await controller.parseUserRequest(req, res);
  } else {
    await controller.audioRequest(req, res);
  }
  return true;
}

/**
 * Proxy a JSON request, record its outcome, and use a credential-backed local fallback on upstream
 * service failure.
 */
async function forwardJson(req: Request, res: Response, upstreamPath: string): Promise<void> {
  const startedAt = Date.now();
  const feature = upstreamPath.includes('parse') ? 'parse' : 'text';
  const localHandler =
    upstreamPath === '/api/text'
      ? 'text'
      : upstreamPath === '/api/parseRequest'
        ? 'parse'
        : null;

  try {
    const result = await fetchUpstreamJson(req, upstreamPath);

    if (upstreamPath === '/api/text' || upstreamPath === '/api/parseRequest') {
      await recordProxyMetrics(
        req,
        { status: result.status, data: result.data } as AxiosResponse,
        startedAt,
        feature
      );
    }

    if (result.status < 500) {
      sendUpstreamResult(res, result);
      return;
    }

    if (localHandler && (await tryLocalAiHandler(req, res, localHandler))) {
      return;
    }

    if (localHandler) {
      res.status(503).json(upstreamUnavailableMessage());
      return;
    }

    sendUpstreamResult(res, result);
  } catch (error) {
    console.error(`[upstreamProxy] ${upstreamPath} failed:`, error);
    if (localHandler && (await tryLocalAiHandler(req, res, localHandler))) {
      return;
    }
    if (localHandler) {
      res.status(503).json(upstreamUnavailableMessage());
      return;
    }
    res.status(502).json({ error: 'Upstream API unavailable' });
  }
}

/**
 * Proxy synthesized audio as binary data, preserving its media type and using local synthesis when
 * available after upstream failure.
 */
async function forwardBinary(req: Request, res: Response, upstreamPath: string): Promise<void> {
  const upstreamRoot = getUpstreamApiRoot();
  const url = `${upstreamRoot}${upstreamPath}`;

  try {
    const upstreamRes = await axios({
      method: req.method,
      url,
      data: req.body,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        ...pickForwardHeaders(req),
      },
      responseType: 'arraybuffer',
      /**
       * Preserve upstream audio errors as responses instead of allowing Axios to discard their
       * status/body path.
       */
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120_000,
    });

    if (upstreamRes.status < 500) {
      res.status(upstreamRes.status);
      if (upstreamRes.headers['content-type']) {
        res.set('Content-Type', upstreamRes.headers['content-type']);
      }
      res.send(Buffer.from(upstreamRes.data));
      return;
    }

    if (await tryLocalAiHandler(req, res, 'audio')) {
      return;
    }

    res.status(503).json(upstreamUnavailableMessage());
  } catch (error) {
    console.error(`[upstreamProxy] ${upstreamPath} failed:`, error);
    if (await tryLocalAiHandler(req, res, 'audio')) {
      return;
    }
    res.status(502).json({ error: 'Upstream API unavailable' });
  }
}

/**
 * Forward a raw audio upload with its original media type and a bounded timeout, returning useful
 * upstream errors.
 */
async function forwardRaw(req: Request, res: Response, upstreamPath: string): Promise<void> {
  const upstreamRoot = getUpstreamApiRoot();
  const url = `${upstreamRoot}${upstreamPath}`;
  const body = req.body instanceof Buffer ? req.body : Buffer.from([]);

  try {
    const upstreamRes = await axios({
      method: 'POST',
      url,
      data: body,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/octet-stream',
        ...pickForwardHeaders(req),
      },
      responseType: 'arraybuffer',
      /** Retain raw-upload error responses so their status and body can be forwarded. */
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120_000,
    });

    res.status(upstreamRes.status);
    if (upstreamRes.headers['content-type']) {
      res.set('Content-Type', upstreamRes.headers['content-type']);
    }
    res.send(Buffer.from(upstreamRes.data));
  } catch (error) {
    console.error(`[upstreamProxy] ${upstreamPath} failed:`, error);
    res.status(502).json({ error: 'Upstream transcribe unavailable' });
  }
}

/** Treat an unknown nonobject response as an empty record before inspecting optional fields. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Select a nonblank string from an unknown field without coercing other types. */
function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Select an actual finite number from an unknown field without accepting numeric strings. */
function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Save the original capture and a failed-stage explanation when a proxied Last Meters request
 * cannot complete.
 */
async function recordProxiedLastMileFailure(
  req: Request,
  startedAt: number,
  error: unknown
): Promise<string | undefined> {
  const body = asRecord(req.body);
  const image = pickString(body.image) ?? '';
  const message = error instanceof Error ? error.message : 'Upstream API unavailable';
  return lastMileTestLogService.record({
    destination: pickString(body.destination) ?? 'unknown destination',
    lat: pickNumber(body.lat) ?? 0,
    lng: pickNumber(body.lng) ?? 0,
    userPhoto: image ? await compressUserPhoto(image) : 'data:,',
    panoramaHeadings: [],
    gpsAccuracyMeters: pickNumber(body.gpsAccuracyMeters),
    deviceHeading: pickNumber(body.heading),
    steps: [
      {
        name: 'proxied_last_mile',
        prompt: 'Forwarded to buddywalk.app. User photo stored locally for the Render dashboard.',
        response: message,
        model: 'upstream-proxy',
        success: false,
        error: message,
      },
    ],
    success: false,
    error: message,
    latencyMs: Date.now() - startedAt,
  });
}

/** Text generation and TTS — needs OPENAI_API_KEY / GEMINI_API_KEY locally. */
export function mountAiProxy(app: Application): void {
  console.log(`[server] Proxying AI to ${getUpstreamApiRoot()}; metrics stored locally`);
  app.post('/api/text', /* Forward text-answer requests through the JSON proxy. */ (req, res) => forwardJson(req, res, '/api/text'));
  app.post('/api/parseRequest', /* Forward question-parsing requests through the JSON proxy. */ (req, res) => forwardJson(req, res, '/api/parseRequest'));
  app.post('/api/audio', /* Forward speech synthesis through the binary proxy. */ (req, res) => forwardBinary(req, res, '/api/audio'));
}

/**
 * Build the constrained photo-and-destination prompt required by an upstream that supports only
 * the legacy text endpoint.
 */
function lastMetersTextPrompt(destination: string): string {
  return (
    `Help me reach the entrance of ${destination}.\n\n` +
    `[Last meters: I attached an image of my surroundings. ` +
    `CRITICAL: do not just read GPS directions. Analyze the image and use it to ` +
    `guide me exactly to the physical door or entrance relative to my current view.]`
  );
}

/**
 * buddywalk.app does not expose /api/last-mile (it 404s). Last Meters still
 * works there as a text+image request, so we rewrite instead of forwarding
 * the dedicated route. The user photo is stored on this host.
 */
async function forwardLastMileViaText(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  const body = asRecord(req.body);
  const destination = pickString(body.destination);
  const image = pickString(body.image);
  const lat = pickNumber(body.lat);
  const lng = pickNumber(body.lng);

  if (!destination || !image || lat === undefined || lng === undefined) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const upstreamRoot = getUpstreamApiRoot();
  const textBody = {
    text: lastMetersTextPrompt(destination),
    image: [image],
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy: pickNumber(body.gpsAccuracyMeters) ?? null,
      heading: pickNumber(body.heading) ?? null,
    },
    analytics: {
      feature: 'last_mile',
    },
  };

  try {
    const upstreamRes = await axios({
      method: 'POST',
      url: `${upstreamRoot}/api/text`,
      data: textBody,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...pickForwardHeaders(req),
      },
      /** Keep the legacy text endpoint's HTTP errors available for pipeline failure logging. */
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 180_000,
    });

    if (upstreamRes.status >= 500 && canRunLocalLastMile()) {
      const { OpenAIController } = await import('../controllers/openAI');
      const controller = new OpenAIController();
      await controller.lastMileRequest(req, res);
      return;
    }

    const output = extractOutputText(upstreamRes.data);
    const success = upstreamRes.status >= 200 && upstreamRes.status < 300;
    const error = success
      ? undefined
      : pickString(asRecord(upstreamRes.data).error) ??
        `Upstream text returned ${upstreamRes.status}`;

    const testLogId = await lastMileTestLogService.record({
      destination,
      lat,
      lng,
      userPhoto: await compressUserPhoto(image),
      panoramaHeadings: [],
      gpsAccuracyMeters: pickNumber(body.gpsAccuracyMeters),
      deviceHeading: pickNumber(body.heading),
      navigationMode: 'exact',
      finalOutput: output,
      steps: [
        {
          name: 'proxied_last_mile_text',
          prompt: 'Rewrote Last Meters as /api/text because buddywalk.app has no /api/last-mile.',
          response: output ?? error ?? '',
          model: 'upstream-text',
          success,
          error,
        },
      ],
      success,
      error,
      latencyMs: Date.now() - startedAt,
    });

    await recordProxyMetrics(
      { ...req, body: { ...textBody, text: destination } } as Request,
      upstreamRes,
      startedAt,
      'last_mile'
    );

    if (!success) {
      res.status(503).json({
        error: error ?? upstreamUnavailableMessage().error,
        testLogId,
      });
      return;
    }

    res.status(200).json({
      output,
      testLogId,
      mode: 'exact',
      warning: error,
    });
  } catch (error) {
    console.error('[upstreamProxy] last-mile via /api/text failed:', error);
    if (canRunLocalLastMile()) {
      const { OpenAIController } = await import('../controllers/openAI');
      const controller = new OpenAIController();
      await controller.lastMileRequest(req, res);
      return;
    }
    const localId = await recordProxiedLastMileFailure(req, startedAt, error);
    res.status(502).json({
      error: 'Upstream API unavailable',
      testLogId: localId,
      detail: upstreamUnavailableMessage().error,
    });
  }
}

/**
 * Last Meters is rewritten to buddywalk.app /api/text because that host has
 * the AI keys but no /api/last-mile route. User photos stay on this host.
 */
export function mountLastMileProxy(app: Application): void {
  console.log(
    `[server] Last Meters → ${getUpstreamApiRoot()}/api/text; user photos stored locally`
  );
  app.post('/api/last-mile', (req, res) => {
    // Adapt a Last Meters request to the legacy upstream text endpoint.
    void forwardLastMileViaText(req, res);
  });
}

/** Azure Speech — needs AZURE_SUBSCRIPTION_KEY and AZURE_REGION locally. */
export function mountSpeechProxy(app: Application): void {
  console.log(`[server] Proxying speech to ${getUpstreamApiRoot()}`);
  app.get('/api/token/getToken', /* Forward speech-token requests through the JSON proxy. */ (req, res) => forwardJson(req, res, '/api/token/getToken'));
  app.post(
    '/api/transcribe',
    express.raw({ type: '*/*', limit: '10mb' }),
    /** Forward microphone uploads through the raw-body proxy. */
    (req, res) => forwardRaw(req, res, '/api/transcribe')
  );
}

/** MTA arrivals — needs MTA_API_KEY locally. */
export function mountMtaProxy(app: Application): void {
  console.log(`[server] Proxying MTA to ${getUpstreamApiRoot()}`);
  app.post('/api/mta', /* Forward transit lookups through the JSON proxy. */ (req, res) => forwardJson(req, res, '/api/mta'));
}

/** Lightweight probe for /api/health — does not log metrics. */
export async function probeUpstreamText(): Promise<{ ok: boolean; status: number }> {
  try {
    const upstreamRoot = getUpstreamApiRoot();
    const upstreamRes = await axios.post(
      `${upstreamRoot}/api/text`,
      { text: 'ping', image: [], coords: null },
      {
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        /** Inspect the upstream probe status directly instead of throwing on an unhealthy endpoint. */
        validateStatus: () => true,
        timeout: 25_000,
      }
    );
    return { ok: upstreamRes.status >= 200 && upstreamRes.status < 300, status: upstreamRes.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
