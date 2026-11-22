import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import express from 'express';
import { mountLastMeters } from '../../server/routes/lastMeters';
import { MobileLastMetersService } from '../../server/services/mobileLastMeters';
import { OpenAIQuestionService } from '../../server/services/openAIQuestionService';
import { requestLastMetersProgress } from '../api/lastMetersProgress';
import { LAST_METERS_PROGRESS_CONTENT_TYPE, type LastMetersProgressEvent } from '../utils/lastMetersProgress';
import { setTestEnv } from './testEnv';

const payload = { destination: 'Library', lat: 40.7, lng: -74, image: 'data:image/jpeg;base64,AAAA' };

async function startServer(t: TestContext) {
  setTestEnv(t, { GOOGLE_MAPS_API_KEY: 'fixture', OPENAI_API_KEY: 'fixture' });
  const app = express();
  app.use(express.json());
  mountLastMeters(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/last-meters`;
}

test('HTTP progress arrives before the final body, and the old client receives identical JSON', { timeout: 7500 }, async t => {
  const url = await startServer(t);
  const body = { output: 'Turn right.', targetHeading: 170, testLogId: 'trial-fixture' };
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const mockedPipeline = t.mock.method(MobileLastMetersService.prototype, 'runLastMeters',
    async (_request, _image, options) => {
      options?.onProgress?.({ type: 'module_started', module: 'preCheck' });
      await gate;
      options?.onProgress?.({ type: 'module_started', module: 'guidance' });
      return { kind: 'response', status: 200, body };
    });
  const received: LastMetersProgressEvent[] = [];
  const result = requestLastMetersProgress(fetch, url, payload, undefined, 5000, event => {
    received.push(event);
    if (event.module === 'preCheck') finish();
  });
  assert.deepEqual(await result, body); // The pipeline can only finish when the client has read the first frame.
  assert.deepEqual(received, [
    { type: 'module_started', module: 'preCheck' }, { type: 'module_started', module: 'guidance' },
  ]);
  const legacy = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(legacy.status, 200);
  assert.match(legacy.headers.get('content-type') ?? '', /^application\/json/);
  assert.deepEqual(await legacy.json(), body);
  assert.equal(mockedPipeline.mock.callCount(), 2);
});

test('an unexpected HTTP streaming failure uses the existing 500 error body', async t => {
  const url = await startServer(t);
  t.mock.method(MobileLastMetersService.prototype, 'runLastMeters', async (_request, _image, options) => {
    options?.onProgress?.({ type: 'module_started', module: 'preCheck' });
    throw new Error('private fixture text');
  });
  await assert.rejects(requestLastMetersProgress(fetch, url, payload, undefined, 5000, () => {}), {
    message: 'Internal server error',
  });
});

test('Last Meters requests routed to Question stream that service’s existing body', async t => {
  const url = await startServer(t);
  t.mock.method(MobileLastMetersService.prototype, 'runLastMeters', async (_request, _image, options) => {
    options?.onProgress?.({ type: 'module_started', module: 'preCheck' });
    return { kind: 'question', textRequest: { text: 'When is the next A train?' } };
  });
  const body = { output: 'The next train information.', history: [], route: null };
  const answer = t.mock.method(OpenAIQuestionService.prototype, 'answerQuestion', async () => ({ status: 200, body }));
  const observed: string[] = [];
  assert.deepEqual(await requestLastMetersProgress(fetch, url, payload, undefined, 5000,
    event => observed.push(event.module)), body);
  assert.equal(answer.mock.callCount(), 1);
  assert.deepEqual(observed, ['preCheck']);
});

test('an older or proxied backend falls back to JSON from the same POST', async t => {
  const body = { output: 'Approach guidance.', warning: 'fixture', targetHeading: null };
  const fake = t.mock.fn(async (url: string, init: RequestInit) => {
    assert.equal(url, 'http://fixture/api/last-meters');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(String(init.body)), payload);
    return Response.json(body);
  });
  assert.deepEqual(await requestLastMetersProgress(fake, 'http://fixture/api/last-meters', payload, undefined, 5000,
    () => assert.fail('The JSON reply has no progress events')), body);
  assert.equal(fake.mock.callCount(), 1);
});

function chunks(...parts: Uint8Array[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      parts.forEach(part => controller.enqueue(part));
      controller.close();
    },
  }), { headers: { 'content-type': LAST_METERS_PROGRESS_CONTENT_TYPE + '; charset=utf-8' } });
}

test('split NDJSON records and UTF-8 preserve the final result', async () => {
  const started = Buffer.from('{"type":"module_started","module":"preCheck"}\n');
  const output = 'Café façade';
  const end = Buffer.from(JSON.stringify({ type: 'result', status: 200, body: { output } }));
  const splitAt = end.indexOf(Buffer.from('é')) + 1;
  const response = chunks(started.subarray(0, 21), started.subarray(21), end.subarray(0, splitAt), end.subarray(splitAt));
  const observed: string[] = [];
  assert.deepEqual(await requestLastMetersProgress(async () => response, 'http://fixture', {}, undefined, 5000,
    event => observed.push(event.module)), { output });
  assert.deepEqual(observed, ['preCheck']);
});

test('a truncated stream never repeats the POST or presents an answer', async t => {
  const fake = t.mock.fn(async () => chunks(Buffer.from('{"type":"module_started","module":"preCheck"}\n')));
  await assert.rejects(requestLastMetersProgress(fake, 'http://fixture', {}, undefined, 5000, () => {}),
    /connection ended before a result/);
  assert.equal(fake.mock.callCount(), 1);
});

for (const cause of ['timeout', 'cancel'] as const) {
  test(`stream transport aborts for ${cause}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const abort = new AbortController();
    const request = requestLastMetersProgress(async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(new Error('fixture aborted')));
        },
      });
      return new Response(body, { headers: { 'content-type': LAST_METERS_PROGRESS_CONTENT_TYPE } });
    }, 'http://fixture', {}, abort.signal, 60_000, () => assert.fail('No module can be announced'));
    if (cause === 'timeout') {
      t.mock.timers.tick(60_000);
      await assert.rejects(request, { code: 'ECONNABORTED' });
    } else {
      abort.abort();
      await assert.rejects(request, /fixture aborted/);
    }
  });
}
