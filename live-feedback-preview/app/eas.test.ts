import { expect, test } from 'bun:test';

import eas from './eas.json';

test('the testflight profile builds the release variant', () => {
  expect(eas.build.testflight.env.APP_VARIANT).toBe('release');
});

test('the development profile builds the development variant', () => {
  expect(eas.build.development).not.toHaveProperty('env.APP_VARIANT');
});
