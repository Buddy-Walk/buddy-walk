import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { getSafetyGateVoicePrompt } from '../utils/safetyGateVoicePrompt';
import { parseLastMetersInput } from '../utils/lastMetersInput';
import { RECAPTURE_MESSAGE, validPoint } from '../utils/lastMetersSafety';
import { mobileResponseSensorReasons } from '../utils/mobileLastMetersGuidance';

// Run the production response handler, speech callback and aiResponse effect
// together without loading native camera/audio modules in Node. Only platform
// boundaries and effect scheduling are replaced; no response logic is copied.
const source = ts.createSourceFile('MainScreen.tsx',
  readFileSync(resolve(__dirname, '../screens/MainScreen.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const main = source.statements.find((s): s is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(s) && s.name?.text === 'MainScreen')!;

function named(name: string): ts.Node {
  for (const statement of main.body!.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (ts.isVariableStatement(statement)) {
      const decl = statement.declarationList.declarations.find(d => ts.isIdentifier(d.name) && d.name.text === name);
      if (decl?.initializer && ts.isCallExpression(decl.initializer)) return decl.initializer.arguments[0];
    }
  }
  throw new Error(`Missing production function ${name}`);
}

const effect = main.body!.statements.flatMap(statement => {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
  const call = statement.expression;
  const deps = call.arguments[1];
  return ts.isIdentifier(call.expression) && call.expression.text === 'useEffect' &&
    deps && ts.isArrayLiteralExpression(deps) && deps.elements.length === 1 &&
    ts.isIdentifier(deps.elements[0]) && deps.elements[0].text === 'aiResponse'
    ? [call.arguments[0]] : [];
})[0];
assert.ok(effect, 'find the real aiResponse effect');

function load(node: ts.Node, context: vm.Context): (...args: any[]) => any {
  const js = ts.transpileModule(`(${node.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  return vm.runInContext(js, context);
}

interface Reply {
  output: string;
  safetyReasons?: string[];
  warning?: string;
  guidanceKind?: 'withheld';
  targetHeading?: number;
  currentHeading?: number;
}

function screen(reply: Reply) {
  const spoken: string[] = [];
  const statuses: string[] = [];
  let pendingEffect = false;
  let stopCount = 0;
  let speaking = false;
  const context = vm.createContext({
    AbortController, Error, console: { error: () => {} },
    getSafetyGateVoicePrompt, parseLastMetersInput, validPoint,
    RECAPTURE_MESSAGE, mobileResponseSensorReasons,
    aiResponse: '', userInput: 'Target', loading: false,
    lastMetersVoiceResponseRef: { current: null },
    lastAutoSpokenRef: { current: '' }, voicePreambleRef: { current: '' },
    lastMetersAbortRef: { current: null }, slowResponseTimerRef: { current: null },
    cameraReadyRef: { current: true }, submittedInputRef: { current: '' },
    chatLogEligibleRef: { current: false }, SLOW_RESPONSE_HINT_MS: 1000,
    speakContent: (text: string) => spoken.push(text),
    speak: (text: string) => statuses.push(text),
    stopSpeaking: async () => { stopCount++; speaking = false; },
    isSpeaking: async () => speaking,
    AccessibilityInfo: { announceForAccessibility: () => {} },
    setLoading: (value: boolean) => { context.loading = value; },
    setLastMetersLoading: () => {},
    setUserInput: (value: string) => { context.userInput = value; },
    setCapturedImage: (value: string | null) => { context.capturedImage = value; },
    setAiResponse: (value: string) => {
      if (context.aiResponse !== value) pendingEffect = true;
      context.aiResponse = value;
    },
    setTimeout: () => 1, clearTimeout: () => {},
    track: async () => {}, Events: { AnswerReceived: 'answer_received' },
    sendLastMetersRequest: async () => reply,
  });
  context.speakAnswer = load(named('speakAnswer'), context);
  context.cancelLastMetersRequest = load(named('cancelLastMetersRequest'), context);
  const handle = load(named('handleLastMetersNavigation'), context);
  const replay = load(named('toggleResponseSpeech'), context);
  const autoSpeak = load(effect, context);
  const prepare = () => {
    const now = Date.now();
    const location = { coords: { latitude: 40.7, longitude: -74, accuracy: 5 }, timestamp: now };
    context.capturedImage = 'data:image/jpeg;base64,photo';
    context.capturedPhotoLocationRef = { current: location };
    context.locationRef = { current: location };
    context.capturedPhotoHeadingRef = { current: 90 };
    context.capturedPhotoHeadingAccuracyRef = { current: 3 };
    context.headingRef = { current: 90 };
    context.headingTimestampRef = { current: now };
    context.headingReferenceRef = { current: 'true' };
    context.capturedSensorMetadataRef = { current: {
      photoCapturedAt: now, positionTimestamp: now, headingTimestamp: now, headingReference: 'true',
    } };
    context.userInput = 'Target';
  };
  prepare();
  return {
    context, spoken, statuses, handle, replay, autoSpeak, prepare,
    flush: () => { if (pendingEffect) { pendingEffect = false; autoSpeak(); } },
    setSpeaking: (value: boolean) => { speaking = value; },
    stopped: () => stopCount,
  };
}

test('backend safety response stays visible while its recovery prompt is spoken exactly once', async () => {
  const output = 'I found Target at its verified address. GPS is too uncertain for a precise turn.';
  const s = screen({ output, warning: 'turn_withheld', guidanceKind: 'withheld', safetyReasons: ['gps_uncertain'] });
  await s.handle();
  s.flush();
  s.autoSpeak(); // repeated effect execution cannot add another speech request
  assert.equal(s.context.aiResponse, output);
  assert.deepEqual(s.spoken, [getSafetyGateVoicePrompt(['gps_uncertain'])]);
  assert.deepEqual(s.statuses, []);
});

test('multiple reasons select only one destination-clarification prompt', async () => {
  const reasons = ['gps_uncertain', 'moved_since_capture', 'destination_branch_ambiguous'];
  const s = screen({ output: 'Please specify the destination.', safetyReasons: reasons });
  await s.handle(); s.flush();
  assert.deepEqual(s.spoken, [getSafetyGateVoicePrompt(reasons)]);
});

test('warning-only heading conflict receives its predefined prompt once', async () => {
  const s = screen({ output: 'The compass and Street View disagree.', warning: 'heading_sources_disagree' });
  await s.handle(); s.flush();
  assert.deepEqual(s.spoken, [getSafetyGateVoicePrompt(undefined, 'heading_sources_disagree')]);
});

for (const reply of [
  { output: 'Turn right toward the verified destination.', targetHeading: 180, currentHeading: 90 },
  { output: 'A future backend explanation.', safetyReasons: ['future_reason'], warning: 'turn_withheld' },
]) {
  test(`normal or unknown response preserves its original spoken text: ${reply.output}`, async () => {
    const s = screen(reply);
    await s.handle(); s.flush();
    assert.equal(s.context.aiResponse, reply.output);
    assert.deepEqual(s.spoken, [reply.output]);
  });
}

for (const reply of [
  { output: 'The same GPS explanation.', safetyReasons: ['gps_uncertain'] },
  { output: 'The same successful turn.', targetHeading: 180, currentHeading: 90 },
]) {
  test(`identical text in two independent requests is spoken once per request: ${reply.output}`, async () => {
    const s = screen(reply);
    await s.handle(); s.flush();
    s.prepare();
    await s.handle(); s.flush();
    const text = getSafetyGateVoicePrompt(reply.safetyReasons) ?? reply.output;
    assert.deepEqual(s.spoken, [text, text]);
  });
}

test('explicit replay repeats the selected prompt, and stop does not request another playback', async () => {
  const s = screen({ output: 'Original backend details.', safetyReasons: ['gps_uncertain'] });
  await s.handle(); s.flush();
  await s.replay();
  const prompt = getSafetyGateVoicePrompt(['gps_uncertain']);
  assert.deepEqual(s.spoken, [prompt, prompt]);
  s.setSpeaking(true);
  const stops = s.stopped();
  await s.replay();
  assert.equal(s.stopped(), stops + 1);
  assert.equal(s.spoken.length, 2);
});

test('a later successful answer replaces the previous safety speech override', async () => {
  const s = screen({ output: 'Old withheld answer.', safetyReasons: ['gps_uncertain'] });
  await s.handle(); s.flush();
  s.prepare();
  s.context.sendLastMetersRequest = async () => ({ output: 'Turn right.', targetHeading: 180, currentHeading: 90 });
  await s.handle(); s.flush();
  await s.replay();
  assert.deepEqual(s.spoken.slice(1), ['Turn right.', 'Turn right.']);
});

test('client sensor rejection still hides and never speaks an invalid backend turn', async () => {
  const s = screen({ output: 'Turn right now.', targetHeading: 180, currentHeading: 90 });
  s.context.headingRef.current = 180;
  await s.handle(); s.flush();
  assert.equal(s.context.aiResponse, RECAPTURE_MESSAGE);
  assert.deepEqual(s.spoken, [RECAPTURE_MESSAGE]);
});

test('invalid capture GPS keeps the existing recapture behavior without duplicate speech', async () => {
  const s = screen({ output: 'Should not be requested.' });
  s.context.capturedPhotoLocationRef.current = null;
  await s.handle(); s.flush();
  assert.equal(s.context.aiResponse, RECAPTURE_MESSAGE);
  assert.deepEqual(s.spoken, [RECAPTURE_MESSAGE]);
});

test('a cancelled request cannot speak its late response', async () => {
  const s = screen({ output: 'Unused.' });
  let resolve!: (reply: Reply) => void;
  s.context.sendLastMetersRequest = () => new Promise<Reply>(done => { resolve = done; });
  const pending = s.handle();
  await s.handle(); // second button press cancels the pending request
  resolve({ output: 'Late backend answer.', safetyReasons: ['gps_uncertain'] });
  await pending; s.flush();
  assert.deepEqual(s.spoken, []);
  assert.equal(s.context.aiResponse, '');
});

test('a transport error retains its existing text and is spoken once', async () => {
  const s = screen({ output: 'Unused.' });
  s.context.sendLastMetersRequest = async () => { throw new Error('offline'); };
  await s.handle(); s.flush();
  assert.equal(s.context.aiResponse, 'Last Meters error: offline');
  assert.deepEqual(s.spoken, ['Last Meters error: offline']);
});
