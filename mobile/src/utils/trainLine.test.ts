import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTrainQuestionWithLiveData,
  extractTrainLineFromText,
  isTrainArrivalQuestion,
} from './trainLine.ts';

describe('extractTrainLineFromText', () => {
  // Group regression cases for: extractTrainLineFromText.
  it('reads numeric and letter lines', () => {
    // Regression test: reads numeric and letter lines.
    assert.equal(extractTrainLineFromText('when is the 4 train arriving'), '4');
    assert.equal(extractTrainLineFromText('next 7 train'), '7');
    assert.equal(extractTrainLineFromText('when is the A train coming'), 'A');
    assert.equal(extractTrainLineFromText('four train arrivals'), '4');
  });

  it('maps common speech-to-text mistakes', () => {
    // Regression test: maps common speech-to-text mistakes.
    assert.equal(extractTrainLineFromText('when is the for train arriving'), '4');
  });

  it('returns null when no line is specified', () => {
    // Regression test: returns null when no line is specified.
    assert.equal(extractTrainLineFromText('when is my train arriving'), null);
  });
});

describe('isTrainArrivalQuestion', () => {
  // Group regression cases for: isTrainArrivalQuestion.
  it('detects arrival questions', () => {
    // Regression test: detects arrival questions.
    assert.equal(isTrainArrivalQuestion('when is the 4 train arriving'), true);
    assert.equal(isTrainArrivalQuestion('what is the weather'), false);
  });
});

describe('buildTrainQuestionWithLiveData', () => {
  // Group regression cases for: buildTrainQuestionWithLiveData.
  it('pins the requested route in the prompt', () => {
    // Regression test: pins the requested route in the prompt.
    const out = buildTrainQuestionWithLiveData('when is the 4 train arriving', '4', 'Nearest station: Foo.');
    assert.match(out, /4 train/);
    assert.match(out, /Nearest station: Foo/);
    assert.match(out, /1-2 sentences/);
  });
});
