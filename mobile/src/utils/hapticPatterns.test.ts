import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PATTERN_LEGEND,
  PATTERNS,
  iconForManeuver,
  labelForManeuver,
  patternForManeuver,
} from './hapticPatterns.ts';

describe('hapticPatterns', () => {
  // Group regression cases for: hapticPatterns.
  it('maps maneuver tokens to distinct vibration patterns', () => {
    // Regression test: maps maneuver tokens to distinct vibration patterns.
    assert.equal(patternForManeuver(undefined), PATTERNS.STRAIGHT);
    assert.equal(patternForManeuver('turn-left'), PATTERNS.LEFT);
    assert.equal(patternForManeuver('turn-right'), PATTERNS.RIGHT);
    assert.equal(patternForManeuver('uturn-left'), PATTERNS.UTURN);
    assert.equal(patternForManeuver('arrive-right'), PATTERNS.ARRIVED);
  });

  it('returns friendly labels for known maneuver families', () => {
    // Regression test: returns friendly labels for known maneuver families.
    assert.equal(labelForManeuver(null), 'Continue');
    assert.equal(labelForManeuver('turn-sharp-left'), 'Sharp left');
    assert.equal(labelForManeuver('turn-slight-right'), 'Slight right');
    assert.equal(labelForManeuver('roundabout-left'), 'Roundabout');
    assert.equal(labelForManeuver('merge'), 'Merge');
    assert.equal(labelForManeuver('unknown'), 'Continue straight');
  });

  it('returns compact display icons without native dependencies', () => {
    // Regression test: returns compact display icons without native dependencies.
    assert.equal(iconForManeuver(undefined), '\u2B06\uFE0F');
    assert.equal(iconForManeuver('turn-left'), '\u2B05\uFE0F');
    assert.equal(iconForManeuver('turn-right'), '\u27A1\uFE0F');
    assert.equal(iconForManeuver('arrive'), '\u{1F3C1}');
  });

  it('keeps the legend aligned with exported pattern keys', () => {
    // Regression test: keeps the legend aligned with exported pattern keys.
    const legendKeys = PATTERN_LEGEND.map(/* Read legend keys so the test can compare legend coverage against all available vibration patterns. */ (entry) => entry.key).sort();
    const patternKeys = Object.keys(PATTERNS).sort();

    assert.deepEqual(legendKeys, patternKeys);
  });
});
