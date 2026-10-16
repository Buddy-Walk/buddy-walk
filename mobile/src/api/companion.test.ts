import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCompanionShareUrl } from './companionUrl.ts';

describe('buildCompanionShareUrl', () => {
  // Group regression cases for: buildCompanionShareUrl.
  it('builds caretaker URLs with encoded tokens', () => {
    // Regression test: builds caretaker URLs with encoded tokens.
    assert.equal(
      buildCompanionShareUrl('abc 123/a', 'https://buddywalk.example.com/'),
      'https://buddywalk.example.com/companion-viewer.html?token=abc123a'
    );
  });

  it('works with base URLs that have no trailing slash', () => {
    // Regression test: works with base URLs that have no trailing slash.
    assert.equal(
      buildCompanionShareUrl('token', 'http://localhost:8000'),
      'http://localhost:8000/companion-viewer.html?token=token'
    );
  });
});
