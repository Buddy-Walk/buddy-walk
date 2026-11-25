import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Application } from 'express';
import {
  SENTRY_DEBUG_MIN_INTERVAL_MS,
  decideDebugEvent,
  hasAdminHeader,
  mountSentryDebugRoute,
} from '../../server/utils/sentryDebugRoute';

function fakeApp(): { app: Application; posts: string[] } {
  const posts: string[] = [];
  const app = {
    post: (path: string) => {
      posts.push(path);
    },
  } as unknown as Application;
  return { app, posts };
}

describe('sentryDebugRoute', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it('stays unmounted unless SENTRY_DEBUG_ROUTE=1', () => {
    delete process.env.SENTRY_DEBUG_ROUTE;
    process.env.ADMIN_TOKEN = 'secret';
    const { app, posts } = fakeApp();
    mountSentryDebugRoute(app);
    assert.deepEqual(posts, []);
  });

  it('stays unmounted without an ADMIN_TOKEN, even with the flag on', () => {
    process.env.SENTRY_DEBUG_ROUTE = '1';
    delete process.env.ADMIN_TOKEN;
    const { app, posts } = fakeApp();
    mountSentryDebugRoute(app);
    assert.deepEqual(posts, []);
  });

  it('mounts a POST route when the flag and the token are both set', () => {
    process.env.SENTRY_DEBUG_ROUTE = '1';
    process.env.ADMIN_TOKEN = 'secret';
    const { app, posts } = fakeApp();
    mountSentryDebugRoute(app);
    assert.deepEqual(posts, ['/api/debug-sentry']);
  });

  it('accepts only the exact admin token, from the header', () => {
    assert.equal(hasAdminHeader('secret', 'secret'), true);
    assert.equal(hasAdminHeader('secreT', 'secret'), false);
    assert.equal(hasAdminHeader('secret-longer', 'secret'), false);
    assert.equal(hasAdminHeader(undefined, 'secret'), false);
    assert.equal(hasAdminHeader(['secret'], 'secret'), false);
    assert.equal(hasAdminHeader('', ''), false);
  });

  it('sends at most one test event per interval', () => {
    const now = 1_000_000;
    assert.equal(decideDebugEvent('secret', 'secret', now, undefined), 202);
    assert.equal(decideDebugEvent('secret', 'secret', now + 1_000, now), 429);
    assert.equal(decideDebugEvent('secret', 'secret', now + SENTRY_DEBUG_MIN_INTERVAL_MS, now), 202);
    assert.equal(decideDebugEvent('wrong', 'secret', now, undefined), 401);
  });
});
