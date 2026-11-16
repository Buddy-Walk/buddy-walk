import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The camera-to-Readings module outlives the first experiment (#118 reuses it),
// so it must not depend on the experiment screen.
test('the Readings module imports nothing from the experiment screen', () => {
  const files = readdirSync(import.meta.dir).filter((file) => /\.tsx?$/.test(file));
  const offending = files.filter((file) => /from '\.\.\/experiment/.test(readFileSync(join(import.meta.dir, file), 'utf8')));

  expect(offending).toEqual([]);
});
