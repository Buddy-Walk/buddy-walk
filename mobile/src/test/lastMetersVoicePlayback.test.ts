import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { getSafetyGateVoicePrompt } from '../utils/safetyGateVoicePrompt';
import { parseLastMetersInput } from '../utils/lastMetersInput';
import { RECAPTURE_MESSAGE, validPoint } from '../utils/lastMetersSafety';
import { mobileResponseSensorReasons } from '../utils/mobileLastMetersGuidance';
import type { LastMetersModule, LastMetersProgressEvent } from '../utils/lastMetersProgress';
import { LAST_METERS_VOICE_PROMPTS, LAST_METERS_STATUS, getLastMetersVoicePriority, getLastMetersVoiceText } from '../utils/lastMetersVoicePrompts';

// Run the production response handler, speech callback and aiResponse effect
// together without loading native camera/audio modules in Node. Only platform
// boundaries and effect scheduling are replaced; no response logic is copied.
const source = ts.createSourceFile('MainScreen.tsx',
  readFileSync(resolve(__dirname, '../screens/MainScreen.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const main = source.statements.find((s): s is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(s) && s.name?.text === 'MainScreen')!;

function hintDelay(name: string): number {
  const decl = source.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(item => item.name.getText(source) === name);
  assert.ok(decl?.initializer && ts.isNumericLiteral(decl.initializer));
  return Number(decl.initializer.text);
}

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
  let focused = true;
  const blurListeners = new Set<() => void>();
  let stopCount = 0;
  let speaking = false;
  const context = vm.createContext({
    navigation: {
      isFocused: () => focused,
      addListener(event: string, listener: () => void) {
        assert.equal(event, 'blur');
        blurListeners.add(listener);
        return () => blurListeners.delete(listener);
      },
    },
    AbortController, Error, console: { error: () => {} },
    getLastMetersVoicePriority, getLastMetersVoiceText, LAST_METERS_STATUS,
    parseLastMetersInput, validPoint, mobileResponseSensorReasons,
    aiResponse: '', userInput: 'Target', loading: false,
    lastMetersVoiceResponseRef: { current: null },
    lastAutoSpokenRef: { current: '' }, voicePreambleRef: { current: '' },
    lastMetersAbortRef: { current: null }, slowResponseTimerRef: { current: null },
    cameraReadyRef: { current: true }, submittedInputRef: { current: '' },
    chatLogEligibleRef: { current: false },
    LAST_METERS_INITIAL_HINT_MS: hintDelay('LAST_METERS_INITIAL_HINT_MS'),
    LAST_METERS_PROGRESS_COALESCE_MS: hintDelay('LAST_METERS_PROGRESS_COALESCE_MS'),
    SLOW_RESPONSE_HINT_MS: hintDelay('SLOW_RESPONSE_HINT_MS'),
    speakContent: (text: string) => spoken.push(text),
    speak: (text: string) => statuses.push(text),
    stopSpeaking: async () => { stopCount++; speaking = false; },
    isSpeaking: async () => speaking,
    AccessibilityInfo: { announceForAccessibility: (text: string) => statuses.push(text) },
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
  context.startLastMetersProgress = load(named('startLastMetersProgress'), context);
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
    setFocused: (value: boolean) => { focused = value; },
    blur: () => { focused = false; blurListeners.forEach(listener => listener()); },
    blurListeners,
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

function mockCamera(s: ReturnType<typeof screen>, takePictureAsync: () => Promise<{ base64: string }>) {
  Object.assign(s.context, {
    cameraRef: { current: { takePictureAsync } },
    takingPhotoRef: { current: false }, videoRecordStartedRef: { current: false },
    headingAccuracyRef: { current: 3 },
    waitForCameraReady: async () => true,
    setTakingPhoto: (value: boolean) => { s.context.takingPhoto = value; },
    setCapturedVideoUri: () => {}, setWebVideoFrames: () => {},
    notifySuccess: () => {}, PHOTO_CAPTURED_VIBRATION: [],
    Vibration: { vibrate: () => {} },
    photoToDataUrl: load(named('photoToDataUrl'), s.context),
  });
  return load(named('takePhoto'), s.context);
}

test('rapid Take Photo taps launch only one native capture and preserve the first tap’s heading', async () => {
  const s = screen({ output: '' });
  let complete!: (photo: { base64: string }) => void;
  let calls = 0;
  const takePhoto = mockCamera(s, () => {
    calls++;
    return new Promise(resolve => { complete = resolve; });
  });
  const first = takePhoto();
  const second = takePhoto(); // Both taps arrive before camera readiness settles.
  await nextTurn();
  assert.equal(calls, 1);
  assert.equal(s.context.takingPhoto, true);
  s.context.headingRef.current = 180;
  await takePhoto(); // Even while the native camera is busy, a tap cannot reach it.
  complete({ base64: 'first-photo' });
  await Promise.all([first, second]);
  assert.equal(s.context.capturedImage, 'data:image/jpeg;base64,first-photo');
  assert.equal(s.context.capturedPhotoHeadingRef.current, 90);
  assert.equal(s.context.takingPhoto, false);
});

test('an iOS camera busy error speaks a retry cue and releases the capture button', async () => {
  const s = screen({ output: '' });
  const loggedErrors: unknown[][] = [];
  s.context.console.error = (...args: unknown[]) => loggedErrors.push(args);
  let calls = 0;
  const takePhoto = mockCamera(s, async () => {
    if (++calls === 1) throw new Error('Camera is not ready yet');
    return { base64: 'retry-photo' };
  });
  await takePhoto();
  assert.deepEqual(loggedErrors, []);
  assert.deepEqual(s.statuses, ['Camera is still getting ready. Try again in a moment.']);
  assert.equal(s.context.takingPhoto, false);
  await takePhoto();
  assert.equal(s.context.capturedImage, 'data:image/jpeg;base64,retry-photo');
  assert.equal(s.context.takingPhoto, false);
});

// Exercise the real playback generation/idle checks as well as the screen handler.
// Replace only the device/audio modules. A test decides when a spoken line finishes.
const playbackJs = ts.transpileModule(readFileSync(resolve(__dirname, '../utils/speakText.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

function playbackModule(modules: Record<string, unknown>, globals = {}) {
  const api = {} as typeof import('../utils/speakText');
  vm.runInNewContext(playbackJs, {
    exports: api, require: (name: string) => modules[name], ...globals,
  });
  return api;
}

function waitingScreen(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const s = screen({ output: '' });
  const events: string[] = [];
  let current: { text: string; onDone(): void; onStopped(): void } | undefined;
  const voice = playbackModule({
    'react-native': { Platform: { OS: 'ios' } },
    './audioSession': { ensurePlaybackThroughSpeaker: async () => {} },
    'expo-speech': {
      speak(text: string, callbacks: { onDone(): void; onStopped(): void }) {
        events.push(text);
        current = { text, ...callbacks };
      },
      stop() {
        if (current) events.push('Stopped: ' + current.text);
        current?.onStopped();
        current = undefined;
      },
    },
  });
  Object.assign(s.context, {
    Date, setTimeout, clearTimeout, speakProgressIfIdle: voice.speakProgressIfIdle,
    speakContent: voice.speakText, speak: voice.speakText, stopSpeaking: voice.stopSpeaking,
  });
  const begin = () => {
    s.prepare();
    let answer!: (reply: Reply) => void;
    let fail!: (error: Error) => void;
    let progress!: (event: LastMetersProgressEvent) => void;
    s.context.sendLastMetersRequest = (_data: unknown, _signal: AbortSignal, onProgress: typeof progress) =>
      new Promise<Reply>((resolve, reject) => {
        answer = resolve;
        fail = reject;
        progress = onProgress;
      });
    const done = s.handle();
    return { answer, fail, done, startModule: (module: LastMetersModule) => progress({ type: 'module_started', module }) };
  };
  return {
    ...s, events, begin,
    tick: async (ms: number) => { t.mock.timers.tick(ms); await nextTurn(); },
    finishSpeech: async () => { current?.onDone(); current = undefined; await nextTurn(); },
  };
}

const firstHint = 'Checking your photo and location.';
const continuingHint = 'Analyzing your surroundings. Please wait.';
const longHint = 'Still checking your surroundings. Tap Last Meters again to cancel.';

test('a reply before 1.5 seconds speaks just the answer, including after timers advance', async t => {
  const s = waitingScreen(t);
  const run = s.begin();
  await s.tick(1499);
  assert.deepEqual(s.events, []);
  run.answer({ output: 'Verified answer.' });
  await run.done; s.flush(); await s.tick(30000);
  assert.deepEqual(s.events, ['Verified answer.']);
  assert.deepEqual(s.statuses, []);
});

test('a long wait gives each idle hint once, then an empty response stops the active reminder', async t => {
  const s = waitingScreen(t);
  const run = s.begin();
  await s.tick(1500);
  assert.deepEqual(s.events, [firstHint]);
  await s.finishSpeech(); await s.tick(3000);
  assert.deepEqual(s.events, [firstHint, continuingHint]);
  await s.finishSpeech(); await s.tick(4500); await s.tick(30000);
  assert.deepEqual(s.events, [firstHint, continuingHint, longHint]);
  run.answer({ output: '' });
  await run.done;
  assert.deepEqual(s.events, [firstHint, continuingHint, longHint, 'Stopped: ' + longHint]);
});

for (const safety of [false, true]) {
  test(`active hint yields immediately to ${safety ? 'Safety Gate recovery' : 'navigation'} and replay keeps the selected answer`, async t => {
    const s = waitingScreen(t);
    const run = s.begin();
    await s.tick(1500);
    // A still-speaking hint must not be interrupted by the next waiting hint.
    await s.tick(3000);
    assert.deepEqual(s.events, [firstHint]);
    const reply = safety ? { output: 'Original details.', safetyReasons: ['gps_uncertain'] } : { output: 'Verified direction.' };
    const expected = safety ? getSafetyGateVoicePrompt(['gps_uncertain'])! : reply.output;
    run.answer(reply);
    await run.done; s.flush(); await s.tick(30000);
    assert.deepEqual(s.events, [firstHint, 'Stopped: ' + firstHint, expected]);
    await s.finishSpeech(); await s.replay(); await nextTurn();
    assert.equal(s.events.at(-1), expected);
  });
}

test('pending audio setup and an already playing safety answer both have priority over progress', async t => {
  const s = waitingScreen(t);
  const run = s.begin();
  s.context.speakAnswer('Safety warning.');
  // The warning has claimed playback but the mocked device has not started speaking yet.
  t.mock.timers.tick(1500);
  await nextTurn(); await s.tick(3000);
  assert.deepEqual(s.events, ['Safety warning.']);
  await s.finishSpeech(); await s.tick(4500);
  assert.deepEqual(s.events, ['Safety warning.', longHint]);
  run.answer({ output: 'Verified answer.' }); await run.done;
});

test('cancelling stops progress once and a late old failure cannot disturb the new request', async t => {
  const s = waitingScreen(t);
  const old = s.begin();
  await s.tick(1500);
  await s.handle(); await nextTurn();
  assert.deepEqual(s.events, [firstHint, 'Stopped: ' + firstHint, 'Last Meters cancelled.']);
  assert.equal(s.context.loading, false);
  await s.finishSpeech();
  const fresh = s.begin();
  old.fail(new Error('stale error')); await old.done;
  assert.equal(s.context.loading, true);
  await s.tick(1500); await s.finishSpeech(); await s.tick(1500);
  assert.deepEqual(s.events.slice(3), [firstHint]); // The old 4.5-second timer is gone.
  fresh.answer({ output: 'New answer.' }); await fresh.done; await s.tick(30000);
  assert.deepEqual(s.events.slice(3), [firstHint, 'New answer.']);
});

test('a slow timeout stops its hint and preserves the existing spoken error exactly once', async t => {
  const s = waitingScreen(t);
  const run = s.begin();
  await s.tick(1500);
  run.fail(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
  await run.done; s.flush(); await s.tick(30000);
  assert.deepEqual(s.events, [firstHint, 'Stopped: ' + firstHint,
    'Last Meters took too long to answer. The server may be busy. Take a new photo and try again.']);
});

test('all five real module events have distinct prompts, with duplicates suppressed', async t => {
  const s = waitingScreen(t);
  const run = s.begin();
  const modules = Object.keys(LAST_METERS_VOICE_PROMPTS) as LastMetersModule[];
  for (const module of modules) {
    run.startModule(module);
    run.startModule(module);
    await s.tick(120);
    await s.finishSpeech();
    run.startModule(module);
    await s.tick(120);
  }
  run.answer({ output: 'Verified details.' }); await run.done; await s.tick(20000);
  assert.deepEqual(s.events, [...Object.values(LAST_METERS_VOICE_PROMPTS), 'Verified details.']);
});

test('concurrent B and C start events share one utterance without a queue', async t => {
  const s = waitingScreen(t);
  const run = s.begin();
  run.startModule('destinationMatch');
  run.startModule('currentViewMatch');
  await s.tick(120);
  run.startModule('turnDecision'); // Playback is occupied.
  await s.tick(120);
  await s.finishSpeech();
  await s.tick(5000);
  run.answer({ output: 'Verified details.' }); await run.done; await s.tick(20000);
  assert.deepEqual(s.events, [
    `${LAST_METERS_VOICE_PROMPTS.currentViewMatch} ${LAST_METERS_VOICE_PROMPTS.destinationMatch}`,
    'Verified details.',
  ]);
});

for (const safety of [false, true]) {
  test(`module speech yields to the ${safety ? 'safety recovery' : 'validated result'} and discards pending prompts`, async t => {
    const s = waitingScreen(t);
    const run = s.begin();
    run.startModule('preCheck');
    await s.tick(120);
    run.startModule('destinationMatch');
    const reply = safety ? { output: 'Original warning details.', safetyReasons: ['gps_uncertain'] } : { output: 'Verified directions.' };
    run.answer(reply);
    await run.done; s.flush(); await s.tick(20000);
    assert.deepEqual(s.events, [
      LAST_METERS_VOICE_PROMPTS.preCheck, 'Stopped: ' + LAST_METERS_VOICE_PROMPTS.preCheck,
      getSafetyGateVoicePrompt(reply.safetyReasons) ?? reply.output,
    ]);
  });
}

test('late module events from a cancelled request cannot reach a new run', async t => {
  const s = waitingScreen(t);
  const old = s.begin();
  old.startModule('preCheck');
  await s.handle();
  await nextTurn(); await s.finishSpeech();
  const fresh = s.begin();
  old.startModule('destinationMatch');
  fresh.startModule('currentViewMatch');
  await s.tick(120);
  old.answer({ output: 'Old response.' }); await old.done;
  await s.finishSpeech();
  fresh.answer({ output: 'Current response.' }); await fresh.done;
  await s.tick(20000);
  assert.deepEqual(s.events, ['Last Meters cancelled.', LAST_METERS_VOICE_PROMPTS.currentViewMatch, 'Current response.']);
});

test('browser voice discovery and fallback timer cannot replay the same completed hint', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lines: string[] = [];
  let voicesReady!: () => void;
  const synth = {
    getVoices: () => [], addEventListener: (_: string, callback: () => void) => { voicesReady = callback; },
    removeEventListener() {}, resume() {}, cancel() {},
    speak(utterance: { text: string; onend(): void }) { lines.push(utterance.text); utterance.onend(); },
  };
  const voice = playbackModule({
    'react-native': { Platform: { OS: 'web' } },
    './webAudioUnlock': { isSafariBrowser: () => false, unlockWebAudioForPlayback() {} },
  }, {
    window: { speechSynthesis: synth, setTimeout },
    SpeechSynthesisUtterance: class { constructor(readonly text: string) {} },
  });
  voice.speakProgressIfIdle(firstHint);
  await nextTurn();
  voicesReady();
  t.mock.timers.tick(200);
  assert.deepEqual(lines, [firstHint]);
});

test('a newer module replaces rapid pending starts before any speech begins', async t => {
  const s = waitingScreen(t);
  const run = s.begin();
  run.startModule('preCheck');
  run.startModule('destinationMatch');
  run.startModule('currentViewMatch');
  run.startModule('turnDecision');
  run.startModule('guidance');
  await s.tick(120);
  assert.deepEqual(s.events, [LAST_METERS_VOICE_PROMPTS.guidance]);
  await s.finishSpeech();
  run.answer({ output: 'Verified answer.' }); await run.done; await s.tick(30000);
  assert.deepEqual(s.events, [LAST_METERS_VOICE_PROMPTS.guidance, 'Verified answer.']);
});

test('a genuine start replaces its own waiting speech, and a recent module suppresses the long reminder', async t => {
  const s = waitingScreen(t);
  const run = s.begin();
  await s.tick(1500);
  await s.tick(3000);
  await s.tick(3500);
  run.startModule('preCheck');
  await s.tick(120);
  await s.finishSpeech();
  await s.tick(880);
  assert.deepEqual(s.events, [firstHint, 'Stopped: ' + firstHint, LAST_METERS_VOICE_PROMPTS.preCheck]);
  run.answer({ output: 'Verified.' }); await run.done;
});

test('the long reminder is still available after an earlier module and a quiet interval', async t => {
  const s = waitingScreen(t);
  const run = s.begin();
  run.startModule('preCheck'); await s.tick(120); await s.finishSpeech();
  await s.tick(1380); await s.tick(3000); await s.tick(4500);
  assert.deepEqual(s.events, [LAST_METERS_VOICE_PROMPTS.preCheck, longHint]);
  run.answer({ output: 'Verified.' }); await run.done;
});

test('cancellation keeps the previous replay target even after a late result', async t => {
  const s = waitingScreen(t);
  const first = s.begin();
  first.answer({ output: 'Original details.', safetyReasons: ['gps_uncertain'] });
  await first.done; s.flush(); await nextTurn(); await s.finishSpeech();
  const second = s.begin();
  second.startModule('currentViewMatch');
  await s.handle(); await nextTurn(); await s.finishSpeech();
  second.answer({ output: 'Late answer.' }); await second.done; s.flush();
  await s.replay(); await s.tick(20000);
  const recovery = getSafetyGateVoicePrompt(['gps_uncertain']);
  assert.deepEqual(s.events, [recovery, 'Last Meters cancelled.', recovery]);
});

test('input validation announces exactly the missing field', async () => {
  const s = screen({ output: 'Unused.' });
  s.context.userInput = ' ';
  await s.handle();
  s.context.userInput = 'Target';
  s.context.capturedImage = null;
  await s.handle();
  assert.deepEqual(s.statuses, [LAST_METERS_STATUS.missing_destination, LAST_METERS_STATUS.missing_photo]);
  assert.deepEqual(s.spoken, []);
});

for (const reader of [true, false]) {
  test(`New Test announces once with the native screen reader ${reader ? 'on' : 'off'}`, async () => {
    const s = screen({ output: '' });
    Object.assign(s.context, {
      Platform: { OS: 'ios' }, isScreenReaderActive: () => reader,
      announce: (text: string) => s.statuses.push(text), rotateConversationId() {},
      setDisplayQuestion() {}, setCapturedVideoUri() {}, setWebVideoFrames() {},
      setCurrentChatId() {}, setCurrentMessageId() {},
    });
    load(named('resetConversationState'), s.context)({ announceReset: true });
    assert.deepEqual(s.statuses, [reader ? LAST_METERS_STATUS.new_test_accessible : LAST_METERS_STATUS.new_test]);
  });
}

test('leaving Main stops active speech and pending progress, even if the old request settles after returning', async t => {
  const s = waitingScreen(t);
  const old = s.begin();
  const signal = s.context.lastMetersAbortRef.current.signal as AbortSignal;
  old.startModule('preCheck');
  await s.tick(120);
  old.startModule('destinationMatch');
  s.blur();
  assert.equal(signal.aborted, true);
  assert.equal(s.context.loading, false);
  assert.equal(s.blurListeners.size, 0);
  old.startModule('guidance');
  await s.tick(10_000);
  const hint = LAST_METERS_VOICE_PROMPTS.preCheck;
  assert.deepEqual(s.events, [hint, 'Stopped: ' + hint]);

  s.setFocused(true);
  const fresh = s.begin();
  old.answer({ output: 'Late result.' });
  await old.done;
  assert.equal(s.context.loading, true);
  fresh.answer({ output: 'Current result.' });
  await fresh.done; s.flush(); await nextTurn();
  assert.deepEqual(s.events, [hint, 'Stopped: ' + hint, 'Current result.']);
  assert.equal(s.blurListeners.size, 0);
});

test('progress callbacks and results check focus even before the blur notification arrives', async t => {
  const s = waitingScreen(t);
  const run = s.begin();
  run.startModule('preCheck');
  s.setFocused(false);
  await s.tick(120);
  run.startModule('destinationMatch');
  await s.tick(10_000);
  run.answer({ output: 'Off-screen result.' });
  await run.done; s.flush(); await nextTurn();
  assert.deepEqual(s.events, []);
  assert.equal(s.context.aiResponse, '');
  assert.equal(s.blurListeners.size, 0);
});
