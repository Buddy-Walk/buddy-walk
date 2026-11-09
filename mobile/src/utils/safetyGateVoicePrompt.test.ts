import assert from 'node:assert/strict';
import test from 'node:test';
import { getSafetyGateVoicePrompt } from './safetyGateVoicePrompt';

const cases: [string, RegExp][] = [
  ['bearing_uncertainty_too_large', /wait for a more accurate location reading/],
  ['destination_branch_ambiguous', /enter a more specific store name or street address/],
  ['capture_metadata_missing', /link this photo to its location and direction readings.*take a new photo/],
  ['moved_since_capture', /reported position changed.*take a new photo/],
  ['turned_since_capture', /phone's direction changed.*hold the phone steady/],
  ['gps_uncertain', /location is not accurate enough.*wait for a more accurate reading/],
  ['current_heading_unavailable', /usable phone direction.*wait for the compass/],
  ['heading_sources_disagree', /compass and the photo-based direction disagree/],
  ['orientation_not_corroborated', /confirm the phone's direction.*take a clear, current photo/],
  ['entrance_not_visually_confirmed', /could not confirm its entrance.*primary navigation or ask for assistance/],
  ['capture_gps_stale', /location reading linked to this photo is out of date.*fresh location reading/],
  ['confidence_not_high', /enough reliable information.*take a clear, current photo/],
  ['current_gps_unavailable', /current location is unavailable.*fresh location reading/],
];

for (const [reason, action] of cases) {
  test(`voice prompt explains the recovery action for ${reason}`, () => {
    const prompt = getSafetyGateVoicePrompt([reason]);
    assert.equal(typeof prompt, 'string');
    assert.match(prompt!, action);
    assert.ok(prompt!.length < 220, 'recovery prompt stays short');
    assert.ok(!prompt!.includes(reason), 'do not speak the technical error code');
  });
}

test('destination clarification wins over GPS and other reasons in either order', () => {
  const reasons = ['moved_since_capture', 'gps_uncertain', 'current_gps_unavailable', 'destination_branch_ambiguous'];
  const expected = getSafetyGateVoicePrompt(['destination_branch_ambiguous']);
  assert.equal(getSafetyGateVoicePrompt(reasons), expected);
  assert.equal(getSafetyGateVoicePrompt([...reasons].reverse()), expected);
});

test('GPS recovery wins over recapture, with unavailable GPS before insufficient accuracy', () => {
  const reasons = ['turned_since_capture', 'gps_uncertain', 'current_gps_unavailable'];
  assert.equal(getSafetyGateVoicePrompt(reasons), getSafetyGateVoicePrompt(['current_gps_unavailable']));
  assert.equal(getSafetyGateVoicePrompt([...reasons].reverse()), getSafetyGateVoicePrompt(reasons));
  assert.equal(getSafetyGateVoicePrompt(['moved_since_capture', 'gps_uncertain']), getSafetyGateVoicePrompt(['gps_uncertain']));
});

test('multiple remaining reasons produce one generic safe recapture instruction', () => {
  const reasons = ['moved_since_capture', 'orientation_not_corroborated', 'bearing_uncertainty_too_large'];
  assert.equal(getSafetyGateVoicePrompt(reasons),
    'I could not confirm your current direction. Stay in a safe place and take a new photo before following a turn.');
  assert.equal(getSafetyGateVoicePrompt([...reasons].reverse()), getSafetyGateVoicePrompt(reasons));
});

test('heading conflict can arrive only in warning, or alongside another active reason', () => {
  const expected = getSafetyGateVoicePrompt(['heading_sources_disagree']);
  assert.equal(getSafetyGateVoicePrompt(undefined, 'heading_sources_disagree'), expected);
  assert.equal(getSafetyGateVoicePrompt(['heading_sources_disagree'], 'heading_sources_disagree'), expected);
  assert.equal(getSafetyGateVoicePrompt(['gps_uncertain'], 'heading_sources_disagree'), getSafetyGateVoicePrompt(['gps_uncertain']));
});

test('unknown, missing and successful responses leave the original speech untouched', () => {
  for (const reasons of [undefined, null, [], ['future_reason'], ['__proto__', 'constructor']]) {
    assert.equal(getSafetyGateVoicePrompt(reasons), undefined);
  }
  assert.equal(getSafetyGateVoicePrompt([], 'turn_withheld'), undefined);
  assert.equal(getSafetyGateVoicePrompt([], 'destination_not_verified'), undefined);
});

test('unknown and repeated codes do not change a known reason or mutate the input', () => {
  const reasons = Object.freeze(['future_reason', 'turned_since_capture', 'turned_since_capture']);
  assert.equal(getSafetyGateVoicePrompt(reasons), getSafetyGateVoicePrompt(['turned_since_capture']));
  assert.deepEqual(reasons, ['future_reason', 'turned_since_capture', 'turned_since_capture']);
});
