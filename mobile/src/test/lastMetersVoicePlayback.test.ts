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
import { createLastMetersMovementShadow, movementShadowTelemetry } from '../utils/lastMetersMovementShadow';

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
const gpsEffect = main.body!.statements.flatMap(statement => {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
  const call = statement.expression;
  return ts.isIdentifier(call.expression) && call.expression.text === 'useEffect' &&
    call.arguments[0]?.getText(source).includes('Location.watchPositionAsync(') ? [call.arguments[0]] : [];
})[0];
assert.ok(gpsEffect, 'find the existing GPS subscription effect');

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
  testLogId?: string;
}

function screen(reply: Reply) {
  const spoken: string[] = [];
  const statuses: string[] = [];
  const telemetry: Array<{ name: string; props: any }> = [];
  let pendingEffect = false;
  let stopCount = 0;
  let speaking = false;
  let requestNumber = 0;
  const context = vm.createContext({
    AbortController, Error, console: { error: () => {} },
    getSafetyGateVoicePrompt, parseLastMetersInput, validPoint,
    RECAPTURE_MESSAGE, mobileResponseSensorReasons,
    createLastMetersMovementShadow, movementShadowTelemetry,
    LAST_METERS_MOVEMENT_SHADOW_ENABLED: false,
    Platform: { OS: 'ios' }, Location: {}, createRequestId: () => `shadow-request-${++requestNumber}`,
    movementShadowRef: { current: null },
    capturedPhotoMovementShadowRef: { current: null },
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
    track: async (name: string, props: any) => { telemetry.push({ name, props }); },
    Events: { AnswerReceived: 'answer_received', LastMetersMovementShadow: 'last_meters_movement_shadow' },
    sendLastMetersRequest: async () => reply,
  });
  context.speakAnswer = load(named('speakAnswer'), context);
  context.movementGpsSample = load(named('movementGpsSample'), context);
  context.stopMovementShadow = load(named('stopMovementShadow'), context);
  context.startMovementShadow = load(named('startMovementShadow'), context);
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
    context, spoken, statuses, telemetry, handle, replay, autoSpeak, prepare,
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

function enableShadow(s: ReturnType<typeof screen>, accuracy = 5) {
  let clock = Date.now();
  const captureAt = clock - 1000;
  s.context.Date = { now: () => clock };
  s.context.capturedSensorMetadataRef.current.photoCapturedAt = captureAt;
  s.context.capturedSensorMetadataRef.current.positionTimestamp = captureAt;
  s.context.capturedPhotoLocationRef.current = {
    coords: { latitude: 40.7, longitude: -74, accuracy }, timestamp: captureAt,
  };
  s.context.locationRef.current = {
    coords: { latitude: 40.7, longitude: -74, accuracy }, timestamp: clock,
  };
  const session = createLastMetersMovementShadow({ captureId: 'capture-1', captureAt,
    capture: { lat: 40.7, lng: -74, accuracy, timestamp: captureAt }, platform: 'web', now: () => clock });
  s.context.movementShadowRef.current = session;
  s.context.capturedPhotoMovementShadowRef.current = session;
  return {
    session,
    advance(meters: number) {
      clock += 5000;
      s.context.locationRef.current = {
        coords: { latitude: 40.7 + meters / 111195, longitude: -74, accuracy }, timestamp: clock,
      };
      s.context.headingTimestampRef.current = clock;
      session.observeGps(s.context.movementGpsSample(s.context.locationRef.current), clock);
    },
    events: () => s.telemetry.filter(e => e.name === 'last_meters_movement_shadow').map(e => e.props),
  };
}

test('shadow flag off requests no activity permission or diagnostic event', async () => {
  const s = screen({ output: 'Turn right.', targetHeading: 180, currentHeading: 90 });
  let permissionCalls = 0;
  s.context.Location = { requestMotionActivityPermissionsAsync: async () => { permissionCalls++; return { status: 'granted' }; } };
  s.context.startMovementShadow(Date.now(), s.context.locationRef.current);
  await s.handle(); s.flush();
  assert.equal(permissionCalls, 0);
  assert.equal(s.context.movementShadowRef.current, null);
  assert.equal(s.telemetry.filter(e => e.name === 'last_meters_movement_shadow').length, 0);
  assert.deepEqual(s.spoken, ['Turn right.']);
});

test('enabled native startup is nonblocking and cancellation prevents a late watcher', async () => {
  const s = screen({ output: 'Unused.' });
  s.context.LAST_METERS_MOVEMENT_SHADOW_ENABLED = true;
  let grant!: (value: { status: string }) => void;
  let watches = 0;
  s.context.Location = {
    requestMotionActivityPermissionsAsync: () => new Promise(resolve => { grant = resolve; }),
    watchMotionActivityAsync: async () => { watches++; return { remove() {} }; },
  };
  s.context.startMovementShadow(Date.now(), s.context.locationRef.current);
  assert.ok(s.context.movementShadowRef.current, 'capture continues while permission is pending');
  s.context.stopMovementShadow('background');
  grant({ status: 'granted' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(watches, 0);
});

test('shadow uncertainty leaves mobile authorization, payload and single speech unchanged', async () => {
  const s = screen({ output: 'Turn right.', targetHeading: 180, currentHeading: 90, testLogId: 'trial-shadow' });
  const shadow = enableShadow(s, 10);
  let payload: any;
  s.context.sendLastMetersRequest = async (request: any) => {
    payload = request; shadow.advance(8);
    return { output: 'Turn right.', targetHeading: 180, currentHeading: 90, testLogId: 'trial-shadow' };
  };
  await s.handle(); s.flush();
  assert.deepEqual(s.spoken, ['Turn right.']);
  assert.deepEqual(Object.keys(payload).sort(), ['compassAccuracyLevel', 'destination', 'gpsAccuracyMeters', 'heading', 'image', 'lat', 'lng', 'sensors'].sort());
  const events = shadow.events();
  assert.equal(events.length, 2);
  assert.equal(events[0].phase, 'submission');
  assert.equal(events[1].phase, 'response');
  assert.equal(events[1].movementState, 'movement_uncertain');
  assert.equal(events[1].strictMoved, true);
  assert.equal(events[1].mobileMoved, false);
  assert.equal(events[1].finalClientReasons, '');
  assert.equal(events[1].testLogId, 'trial-shadow');
  assert.equal(events[0].requestId, events[1].requestId);
  assert.equal(events[0].captureId, events[1].captureId);
});

test('movement during server processing is logged at T3 and the old safety gate still rejects the turn', async () => {
  const s = screen({ output: 'Unused.' });
  const shadow = enableShadow(s, 2);
  s.context.sendLastMetersRequest = async () => {
    shadow.advance(20);
    s.context.headingRef.current = 180;
    return { output: 'Unsafe turn.', targetHeading: 180, currentHeading: 90 };
  };
  await s.handle(); s.flush();
  assert.equal(s.context.aiResponse, RECAPTURE_MESSAGE);
  assert.deepEqual(s.spoken, [RECAPTURE_MESSAGE]);
  const [submission, response] = shadow.events();
  assert.equal(submission.movementState, 'movement_uncertain');
  assert.equal(response.movementState, 'movement_detected');
  assert.ok(response.finalClientReasons.includes('moved_since_capture'));
  assert.ok(response.finalClientReasons.includes('turned_since_capture'));
  assert.equal(response.preciseTurnCheckApplied, true);
});

test('withheld responses retain server reasons and do not introduce a new final turn gate', async () => {
  const s = screen({ output: 'Backend details.', warning: 'turn_withheld', guidanceKind: 'withheld', safetyReasons: ['gps_uncertain'] });
  const shadow = enableShadow(s);
  shadow.advance(20);
  await s.handle(); s.flush();
  const response = shadow.events()[1];
  assert.equal(response.preciseTurnCheckApplied, false);
  assert.equal(response.serverReasons, 'gps_uncertain');
  assert.equal(response.serverWarning, 'turn_withheld');
  assert.equal(s.context.aiResponse, 'Backend details.');
  assert.equal(s.spoken.length, 1);
});

test('shadow diagnostic failure cannot replace the existing navigation response', async () => {
  const s = screen({ output: 'Turn right.', targetHeading: 180, currentHeading: 90 });
  s.context.capturedPhotoMovementShadowRef.current = { captureId: 'broken', snapshot() { throw new Error('diagnostic'); }, stop() {} };
  await s.handle(); s.flush();
  assert.deepEqual(s.spoken, ['Turn right.']);
});

test('cancelled response emits no T3 diagnostic or speech and stops its own session', async () => {
  const s = screen({ output: 'Unused.' });
  const shadow = enableShadow(s);
  let resolveReply!: (value: Reply) => void;
  s.context.sendLastMetersRequest = () => new Promise<Reply>(resolve => { resolveReply = resolve; });
  const pending = s.handle();
  await s.handle();
  resolveReply({ output: 'Late turn.', targetHeading: 180, currentHeading: 90 });
  await pending; s.flush();
  assert.equal(shadow.events().length, 1);
  assert.deepEqual(s.spoken, []);
});

function photoScreen() {
  const s = screen({ output: 'Unused.' });
  const completions: Array<(photo: any) => void> = [];
  let time = Date.now();
  s.context.Date = { now: () => ++time };
  Object.assign(s.context, {
    LAST_METERS_MOVEMENT_SHADOW_ENABLED: true, Platform: { OS: 'web' },
    cameraRef: { current: { takePictureAsync: () => new Promise(resolve => completions.push(resolve)) } },
    waitForCameraReady: async () => true,
    headingAccuracyRef: { current: 3 }, notifySuccess() {},
    setCapturedVideoUri() {}, setWebVideoFrames() {},
    Vibration: { vibrate() {} }, PHOTO_CAPTURED_VIBRATION: [],
  });
  s.context.photoToDataUrl = load(named('photoToDataUrl'), s.context);
  return { ...s, completions, take: load(named('takePhoto'), s.context) };
}

test('a failed older photo cannot stop a newer photo motion session', async () => {
  const s = photoScreen();
  const first = s.take(); await new Promise<void>(resolve => setImmediate(resolve));
  const firstSession = s.context.movementShadowRef.current;
  const second = s.take(); await new Promise<void>(resolve => setImmediate(resolve));
  const secondSession = s.context.movementShadowRef.current;
  assert.notEqual(firstSession, secondSession);
  s.completions[0](null); await first;
  s.completions[1]({ base64: 'second' }); await second;
  assert.equal(s.context.capturedPhotoMovementShadowRef.current, secondSession);
  const result = secondSession.snapshot({ requestedAt: Date.now(), observedAt: Date.now() });
  assert.equal(result.assessment.motion.stopReason, undefined);
  s.context.stopMovementShadow('completed');
});

test('overlapping photo completion keeps each photo tied to its own diagnostic session', async () => {
  const s = photoScreen();
  const first = s.take(); await new Promise<void>(resolve => setImmediate(resolve));
  const firstSession = s.context.movementShadowRef.current;
  const second = s.take(); await new Promise<void>(resolve => setImmediate(resolve));
  const secondSession = s.context.movementShadowRef.current;
  s.completions[1]({ base64: 'second' }); await second;
  s.completions[0]({ base64: 'first' }); await first;
  assert.equal(s.context.capturedImage, 'data:image/jpeg;base64,first');
  assert.equal(s.context.capturedPhotoMovementShadowRef.current, firstSession);
  assert.equal(s.context.movementShadowRef.current, secondSession);
  const result = firstSession.snapshot({ requestedAt: Date.now(), observedAt: Date.now() });
  assert.equal(result.assessment.motion.captureAt, s.context.capturedSensorMetadataRef.current.photoCapturedAt);
  assert.equal(result.assessment.motion.stopReason, 'retake');
  await s.handle();
  const unused = secondSession.snapshot({ requestedAt: Date.now(), observedAt: Date.now() });
  assert.equal(unused.assessment.motion.stopReason, 'photo_not_selected');
  s.context.stopMovementShadow('completed');
});

const boundaryFlush = () => new Promise<void>(resolve => setImmediate(resolve));

test('the existing GPS watcher is reused once and forwards real reported speed into photo-session history', async (t) => {
  const s = screen({ output: 'Unused.' });
  const start = Date.now();
  let clock = start;
  const capture = { coords: { latitude: 40.7, longitude: -74, accuracy: 3, speed: 0 }, timestamp: start };
  let callback!: (value: any) => void;
  let watches = 0, removals = 0;
  s.context.Platform.OS = 'web';
  s.context.locationRef.current = capture;
  s.context.Location = {
    Accuracy: { Balanced: 1, BestForNavigation: 6 },
    requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
    getCurrentPositionAsync: async () => capture,
    watchPositionAsync: async (options: any, cb: (value: any) => void) => {
      watches++; callback = cb;
      assert.equal(options.timeInterval, 1000);
      return { remove() { removals++; } };
    },
  };
  const session = createLastMetersMovementShadow({ captureId: 'watcher', captureAt: start,
    capture: s.context.movementGpsSample(capture), platform: 'web', now: () => clock });
  t.after(() => session.stop());
  s.context.movementShadowRef.current = { observeGps: (fix: any) => session.observeGps(fix, clock) };
  const cleanup = load(gpsEffect, s.context)();
  await boundaryFlush();
  for (const [meters, seconds, speed] of [[2, 2, 1], [3, 5, 1 / 3]]) {
    clock = start + seconds * 1000;
    callback({ coords: { ...capture.coords, latitude: capture.coords.latitude + meters / 6371000 * 180 / Math.PI, speed }, timestamp: clock });
  }
  const result = session.snapshot({ latest: s.context.movementGpsSample(s.context.locationRef.current), requestedAt: clock, observedAt: clock });
  assert.equal(watches, 1);
  assert.equal(result.assessment.history!.samples, 2);
  assert.equal(result.assessment.history!.reportedSpeed.count, 2);
  assert.ok(Math.abs(result.assessment.history!.reportedSpeed.mean! - 2 / 3) < 1e-9);
  assert.ok(Math.abs(result.assessment.history!.apparentSpeed.mean! - 2 / 3) < 1e-6);
  assert.equal(result.assessment.history!.maxGapMs, 3000);
  cleanup();
  const last = s.context.locationRef.current;
  callback({ ...capture, timestamp: clock + 1000 });
  assert.equal(s.context.locationRef.current, last, 'a disposed callback cannot overwrite live location');
  assert.equal(removals, 1);
});

test('unmount while GPS permission is pending does not start a location subscription', async () => {
  const s = screen({ output: 'Unused.' });
  let grant!: (value: any) => void;
  let watches = 0;
  s.context.Location = {
    requestForegroundPermissionsAsync: () => new Promise(resolve => { grant = resolve; }),
    watchPositionAsync: async () => { watches++; return { remove() {} }; },
  };
  const cleanup = load(gpsEffect, s.context)();
  cleanup(); grant({ status: 'granted' }); await boundaryFlush();
  assert.equal(watches, 0);
});

test('an existing GPS subscription resolving after unmount is removed once', async () => {
  const s = screen({ output: 'Unused.' });
  let resolveWatch!: (value: any) => void;
  let removals = 0;
  s.context.Location = {
    Accuracy: { Balanced: 1, BestForNavigation: 6 },
    requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
    getCurrentPositionAsync: async () => s.context.locationRef.current,
    watchPositionAsync: () => new Promise(resolve => { resolveWatch = resolve; }),
  };
  const cleanup = load(gpsEffect, s.context)();
  await boundaryFlush(); cleanup();
  resolveWatch({ remove() { removals++; } }); await boundaryFlush();
  assert.equal(removals, 1);
});

test('native GPS watcher startup failure is recorded as unavailable without throwing from the effect', async () => {
  const s = screen({ output: 'Unused.' });
  let unavailable = 0;
  s.context.movementShadowRef.current = { markGpsUnavailable() { unavailable++; } };
  s.context.Location = {
    Accuracy: { Balanced: 1, BestForNavigation: 6 },
    requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
    getCurrentPositionAsync: async () => s.context.locationRef.current,
    watchPositionAsync: async () => { throw new Error('native location unavailable'); },
  };
  const cleanup = load(gpsEffect, s.context)();
  await boundaryFlush(); cleanup();
  assert.equal(unavailable, 1);
});

test('a heading subscription resolving after the shared GPS effect is disposed is also cleaned up', async () => {
  const s = screen({ output: 'Unused.' });
  let resolveHeading!: (value: any) => void;
  let gpsRemovals = 0, headingRemovals = 0;
  s.context.Location = {
    Accuracy: { Balanced: 1, BestForNavigation: 6 },
    requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
    getCurrentPositionAsync: async () => s.context.locationRef.current,
    watchPositionAsync: async () => ({ remove() { gpsRemovals++; } }),
    watchHeadingAsync: () => new Promise(resolve => { resolveHeading = resolve; }),
  };
  const cleanup = load(gpsEffect, s.context)();
  await boundaryFlush(); cleanup();
  resolveHeading({ remove() { headingRemovals++; } }); await boundaryFlush();
  assert.equal(gpsRemovals, 1); assert.equal(headingRemovals, 1);
});

test('late completion of a cancelled request cannot stop a new photo/request speed history', async () => {
  const s = screen({ output: 'Unused.' });
  const first = enableShadow(s);
  let firstReply!: (value: Reply) => void, secondReply!: (value: Reply) => void;
  let calls = 0;
  s.context.sendLastMetersRequest = () => new Promise<Reply>(resolve => {
    if (++calls === 1) firstReply = resolve; else secondReply = resolve;
  });
  const a = s.handle();
  s.context.cancelLastMetersRequest();
  // New Test/reset can clear loading while an aborted transport still has an unsettled promise.
  s.context.loading = false; s.prepare();
  const second = enableShadow(s);
  const b = s.handle();
  firstReply({ output: 'Old response.' }); await a;
  second.advance(2);
  const result = second.session.snapshot({ latest: s.context.movementGpsSample(s.context.locationRef.current),
    requestedAt: Date.now(), observedAt: s.context.locationRef.current.timestamp });
  assert.equal(result.assessment.history!.stoppedReason, undefined);
  assert.equal(result.assessment.history!.samples, 1);
  secondReply({ output: 'New response.' }); await b; s.flush();
  assert.deepEqual(s.spoken, ['New response.']);
  const events = second.events();
  assert.equal(events.filter(e => e.phase === 'response').length, 1);
  assert.notEqual(events[0].requestId, events[1].requestId);
  first.session.stop(); second.session.stop();
});
