import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyOwnedApiHostGuardrail,
  isLegacyApiHost,
  OWNED_API_ROOT,
} from './apiHosts.ts';

describe('api host guardrails', () => {
  // Group regression cases for: api host guardrails.
  it('treats buddywalk.app as legacy', () => {
    // Regression test: treats buddywalk.app as legacy.
    assert.equal(isLegacyApiHost('https://buddywalk.app'), true);
    assert.equal(isLegacyApiHost('https://www.buddywalk.app/api'), true);
  });

  it('redirects legacy hosts to the owned Render API', () => {
    // Regression test: redirects legacy hosts to the owned Render API.
    assert.equal(applyOwnedApiHostGuardrail('https://buddywalk.app'), OWNED_API_ROOT);
    assert.equal(
      applyOwnedApiHostGuardrail('https://buddy-walk-api.onrender.com'),
      'https://buddy-walk-api.onrender.com'
    );
  });

  it('leaves LAN dev hosts alone', () => {
    // Regression test: leaves LAN dev hosts alone.
    assert.equal(
      applyOwnedApiHostGuardrail('http://192.168.1.50:8000'),
      'http://192.168.1.50:8000'
    );
  });
});
