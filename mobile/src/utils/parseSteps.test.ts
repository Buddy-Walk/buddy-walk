import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractDestinationQuery, inferManeuverFromText, parseStepsFromText } from './parseSteps.ts';

describe('inferManeuverFromText', () => {
  // Group regression cases for: inferManeuverFromText.
  it('detects unambiguous turn and arrival wording', () => {
    // Regression test: detects unambiguous turn and arrival wording.
    assert.equal(inferManeuverFromText('Turn left onto Main Street.'), 'turn-left');
    assert.equal(inferManeuverFromText('Make a right at the light.'), 'turn-right');
    assert.equal(inferManeuverFromText('You have arrived at your destination.'), 'arrive');
  });

  it('does not treat landmarks on either side as turns', () => {
    // Regression test: does not treat landmarks on either side as turns.
    assert.equal(inferManeuverFromText('Continue with the park on your left.'), 'straight');
    assert.equal(inferManeuverFromText('Walk forward with the store on your right.'), 'straight');
  });

  it('prefers specific maneuver variants when present', () => {
    // Regression test: prefers specific maneuver variants when present.
    assert.equal(inferManeuverFromText('Bear slight left after the plaza.'), 'turn-slight-left');
    assert.equal(inferManeuverFromText('Take a sharp right at the corner.'), 'turn-sharp-right');
    assert.equal(inferManeuverFromText('Make a U-turn when safe.'), 'uturn-left');
  });
});

describe('parseStepsFromText', () => {
  // Group regression cases for: parseStepsFromText.
  it('parses explicit Step N directions and normalizes metadata', () => {
    // Regression test: parses explicit Step N directions and normalizes metadata.
    const route = parseStepsFromText(`
      Step 2) Turn right onto Pine Street for 120 ft.
      Step 1. Head north on Oak Avenue.
      Step 3: You have arrived at your destination.
    `);

    assert.ok(route);
    assert.deepEqual(
      route.steps.map(/* Select normalized step metadata to verify parsing without depending on unrelated route fields. */ (step) => ({
        index: step.index,
        instruction: step.instruction,
        maneuver: step.maneuver,
        startLocation: step.startLocation,
        endLocation: step.endLocation,
      })),
      [
        {
          index: 0,
          instruction: 'Head north on Oak Avenue.',
          maneuver: 'straight',
          startLocation: { lat: 0, lng: 0 },
          endLocation: { lat: 0, lng: 0 },
        },
        {
          index: 1,
          instruction: 'Turn right onto Pine Street',
          maneuver: 'turn-right',
          startLocation: { lat: 0, lng: 0 },
          endLocation: { lat: 0, lng: 0 },
        },
        {
          index: 2,
          instruction: 'You have arrived at your destination.',
          maneuver: 'arrive',
          startLocation: { lat: 0, lng: 0 },
          endLocation: { lat: 0, lng: 0 },
        },
      ]
    );
    assert.equal(route.steps[1].distance.value, 37);
    assert.ok(route.steps[1].distance.text.includes('feet'));
  });

  it('falls back to numbered direction lists when Step labels are absent', () => {
    // Regression test: falls back to numbered direction lists when Step labels are absent.
    const route = parseStepsFromText(`
      1. Walk east on 4th Street.
      2) Bear left at the split.
      3: Destination is on your right.
    `);

    assert.ok(route);
    assert.deepEqual(
      route.steps.map(/* Read instruction/maneuver pairs to check numbered prose conversion. */ (step) => [step.instruction, step.maneuver]),
      [
        ['Walk east on 4th Street.', 'straight'],
        ['Bear left at the split.', 'turn-slight-left'],
        ['Destination is on your right.', 'arrive'],
      ]
    );
  });

  it('falls back to directional sentences and rejects unrelated text', () => {
    // Regression test: falls back to directional sentences and rejects unrelated text.
    const route = parseStepsFromText(
      'Head south toward the entrance. Continue past the lobby. The weather is nice today.'
    );

    assert.ok(route);
    assert.deepEqual(
      route.steps.map(/* Read parsed instruction text to ensure unrelated prose does not become a walking step. */ (step) => step.instruction),
      ['Head south toward the entrance.', 'Continue past the lobby.']
    );

    assert.equal(parseStepsFromText('This answer has no walking instructions.'), null);
    assert.equal(parseStepsFromText(''), null);
  });
});

describe('extractDestinationQuery', () => {
  // Group regression cases for: extractDestinationQuery.
  it('pulls the destination from common navigation phrasings', () => {
    // Regression test: pulls the destination from common navigation phrasings.
    assert.equal(extractDestinationQuery("how do I get to Trader Joe's?"), "Trader Joe's");
    assert.equal(extractDestinationQuery('directions to 123 Main Street'), '123 Main Street');
    assert.equal(extractDestinationQuery('navigate to Central Park.'), 'Central Park');
    assert.equal(extractDestinationQuery('go to the store'), 'store');
  });

  it('strips leading articles and trailing punctuation', () => {
    // Regression test: strips leading articles and trailing punctuation.
    assert.equal(extractDestinationQuery('take me to the library!'), 'library');
    assert.equal(extractDestinationQuery('walk to a pharmacy'), 'pharmacy');
  });

  it('returns null when no destination is present', () => {
    // Regression test: returns null when no destination is present.
    assert.equal(extractDestinationQuery('what is around me right now?'), null);
    assert.equal(extractDestinationQuery(''), null);
    assert.equal(extractDestinationQuery('describe the scene'), null);
  });
});
