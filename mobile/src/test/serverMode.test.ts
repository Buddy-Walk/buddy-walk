import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  describeServerMode,
  getServiceRouting,
  getUpstreamApiRoot,
  isZeroConfigMode,
} from '../../server/config/serverMode';

const CREDENTIAL_VARS = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'AZURE_SUBSCRIPTION_KEY',
  'AZURE_REGION',
  'MTA_API_KEY',
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_API_KEY',
  'ZERO_CONFIG',
];

/**
 * Clear every service credential and routing override before constructing an isolated server-mode
 * scenario.
 */
function clearCredentials(): void {
  for (const name of CREDENTIAL_VARS) delete process.env[name];
}

describe('serverMode', () => {
  // Group regression cases for: serverMode.
  const env = { ...process.env };

  afterEach(() => {
    // Restore the entire original environment after each mode-selection test.
    process.env = { ...env };
  });

  it('proxies every capability when no keys are set', () => {
    // Regression test: proxies every capability when no keys are set.
    clearCredentials();
    assert.deepEqual(getServiceRouting(), {
      ai: 'proxy',
      speech: 'proxy',
      mta: 'proxy',
      lastMile: 'proxy',
    });
    assert.equal(describeServerMode().mode, 'zero-config');
    assert.equal(isZeroConfigMode(), true);
  });

  it('serves every capability locally when all keys are set', () => {
    // Regression test: serves every capability locally when all keys are set.
    clearCredentials();
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.AZURE_SUBSCRIPTION_KEY = 'azure-test';
    process.env.AZURE_REGION = 'eastus';
    process.env.MTA_API_KEY = 'mta-test';
    process.env.GOOGLE_MAPS_API_KEY = 'maps-test';
    assert.deepEqual(getServiceRouting(), {
      ai: 'local',
      speech: 'local',
      mta: 'local',
      lastMile: 'local',
    });
    assert.equal(describeServerMode().mode, 'self-hosted');
    assert.equal(isZeroConfigMode(), false);
  });

  // Regression: an OpenAI key used to flip a single global flag that also
  // pulled speech off the upstream proxy and onto an unconfigured local
  // route, returning 500 for every speech token and breaking voice input.
  it('keeps speech on the proxy when only an AI key is present', () => {
    // Regression test: keeps speech on the proxy when only an AI key is present.
    clearCredentials();
    process.env.OPENAI_API_KEY = 'sk-test';
    const routing = getServiceRouting();
    assert.equal(routing.ai, 'local');
    assert.equal(routing.speech, 'proxy');
    assert.equal(routing.mta, 'proxy');
    assert.equal(routing.lastMile, 'proxy');
    assert.equal(describeServerMode().mode, 'mixed');
  });

  it('keeps AI on the proxy when only speech keys are present', () => {
    // Regression test: keeps AI on the proxy when only speech keys are present.
    clearCredentials();
    process.env.AZURE_SUBSCRIPTION_KEY = 'azure-test';
    process.env.AZURE_REGION = 'eastus';
    const routing = getServiceRouting();
    assert.equal(routing.speech, 'local');
    assert.equal(routing.ai, 'proxy');
  });

  it('requires both Azure key and region before serving speech locally', () => {
    // Regression test: requires both Azure key and region before serving speech locally.
    clearCredentials();
    process.env.AZURE_SUBSCRIPTION_KEY = 'azure-test';
    assert.equal(getServiceRouting().speech, 'proxy');

    process.env.AZURE_REGION = '   ';
    assert.equal(getServiceRouting().speech, 'proxy');

    process.env.AZURE_REGION = 'eastus';
    assert.equal(getServiceRouting().speech, 'local');
  });

  it('lets ZERO_CONFIG force speech and MTA proxying even when keys exist', () => {
    // Regression test: lets ZERO_CONFIG force speech and MTA proxying even when keys exist.
    clearCredentials();
    process.env.AZURE_SUBSCRIPTION_KEY = 'azure-test';
    process.env.AZURE_REGION = 'eastus';
    process.env.MTA_API_KEY = 'mta-test';
    process.env.ZERO_CONFIG = 'true';
    assert.deepEqual(getServiceRouting(), {
      ai: 'proxy',
      speech: 'proxy',
      mta: 'proxy',
      lastMile: 'proxy',
    });
  });

  // Regression: buddywalk.app /api/text returns 500, so ZERO_CONFIG on Render
  // sent every question through a failing upstream before the local fallback.
  it('keeps AI and Last Meters local under ZERO_CONFIG when their keys exist', () => {
    // Regression test: keeps AI and Last Meters local under ZERO_CONFIG when their keys exist.
    clearCredentials();
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.ZERO_CONFIG = 'true';
    assert.equal(getServiceRouting().ai, 'local');
    assert.equal(getServiceRouting().lastMile, 'proxy');

    process.env.GOOGLE_MAPS_API_KEY = 'maps-test';
    assert.equal(getServiceRouting().lastMile, 'local');
    assert.equal(getServiceRouting().speech, 'proxy');
  });

  it('lets ZERO_CONFIG=false force local handlers', () => {
    // Regression test: lets ZERO_CONFIG=false force local handlers.
    clearCredentials();
    process.env.ZERO_CONFIG = 'false';
    assert.deepEqual(getServiceRouting(), {
      ai: 'local',
      speech: 'local',
      mta: 'local',
      lastMile: 'local',
    });
  });

  it('keeps Last Meters on the proxy unless both AI and Maps keys exist', () => {
    // Regression test: keeps Last Meters on the proxy unless both AI and Maps keys exist.
    clearCredentials();
    process.env.OPENAI_API_KEY = 'sk-test';
    assert.equal(getServiceRouting().lastMile, 'proxy');

    process.env.GOOGLE_MAPS_API_KEY = 'maps-test';
    assert.equal(getServiceRouting().lastMile, 'local');
  });

  it('reports the upstream whenever anything is still proxied', () => {
    // Regression test: reports the upstream whenever anything is still proxied.
    clearCredentials();
    process.env.OPENAI_API_KEY = 'sk-test';
    assert.equal(describeServerMode().upstream, 'https://buddywalk.app');
  });

  it('normalizes upstream root', () => {
    // Regression test: normalizes upstream root.
    process.env.UPSTREAM_API_ROOT = 'https://buddywalk.app/api/';
    assert.equal(getUpstreamApiRoot(), 'https://buddywalk.app');
  });
});

export {};
