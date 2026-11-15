import Constants from 'expo-constants';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { FrameReadings, Reading } from '../readings/Reading';
import { ReadingsCamera, type ReadingsCameraRef } from '../readings/ReadingsCamera';
import { fileSystemSessionsRoot } from './fileSystemSessionsRoot';
import { withLaptopCopy } from './laptopCopy';
import type { MarkFields } from './markForm';
import { MarkFormSheet } from './MarkFormSheet';
import { PastSessions } from './PastSessions';
import type { Mark } from './session';
import { currentSessionInfo } from './sessionInfo';
import { createSessionStore, type SessionRecorder } from './sessionStore';
import { useHeading } from './useHeading';

const RECENT_READINGS = 8;

const KEEP_AWAKE_TAG = 'experiment-session';

/** A Mark whose frame is saved and whose form is still open. */
type OpenMark = Omit<Mark, keyof MarkFields>;

/**
 * The first experiment's screen (#106): live Readings over the camera, experiment sessions, and Marks.
 * It is for a sighted tester and goes away after the experiment.
 */
export function ExperimentScreen() {
  const store = useMemo(() => createSessionStore(sessionsRoot()), []);
  const camera = useRef<ReadingsCameraRef>(null);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [recorder, setRecorder] = useState<SessionRecorder | null>(null);
  const [loggedCount, setLoggedCount] = useState(0);
  const [currentReadings, setCurrentReadings] = useState<Reading[]>([]);
  const [recent, setRecent] = useState<Reading[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [openMark, setOpenMark] = useState<OpenMark | null>(null);
  const [showingSessions, setShowingSessions] = useState(false);
  const heading = useHeading(recorder !== null);

  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => subscription.remove();
  }, []);

  // Logging pauses while the camera is stopped in the background, which keeps that time out of the
  // frame rate and saves what is buffered in case iOS ends the app. It also pauses while a Mark's
  // form is open, which keeps the time spent filling it in out of the frame rate.
  const logging = appActive && openMark === null;
  const loggingRef = useRef(logging);
  loggingRef.current = logging;
  useEffect(() => {
    if (!recorder) return;
    if (logging) recorder.resume();
    else recorder.pause();
  }, [recorder, logging]);

  // An auto-locked phone stops the camera partway through a walk, so the screen stays on while recording.
  const recording = recorder !== null;
  useEffect(() => {
    if (!recording) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [recording]);

  // Text is read only while recording, so nothing is read while the tester gets ready, and not while
  // a Mark's form is open, where boxes moving behind the form are a distraction.
  const readingText = recording && openMark === null;
  useEffect(() => {
    if (!readingText) setCurrentReadings([]);
  }, [readingText]);

  function onFrameReadings(frame: FrameReadings) {
    setCurrentReadings(frame.readings);
    if (frame.readings.length > 0) setRecent((previous) => [...frame.readings, ...previous].slice(0, RECENT_READINGS));
    const active = recorderRef.current;
    if (active && loggingRef.current) {
      active.addFrame(frame, heading.current);
      if (frame.readings.length > 0) setLoggedCount((count) => count + frame.readings.length);
    }
  }

  function startSession() {
    setLoggedCount(0);
    setRecent([]);
    setRecorder(store.start(currentSessionInfo()));
  }

  function stopSession() {
    recorder?.stop();
    setRecorder(null);
  }

  async function mark() {
    if (!recorder || !camera.current) return;
    const markedAt = new Date().toISOString();
    const headingAtTap = heading.current;
    setCapturing(true);
    try {
      const snapshot = await camera.current.takeSnapshot();
      const jpeg = await snapshot.image.toEncodedImageDataAsync('jpg', 90);
      const frameFile = recorder.saveMarkFrame(new Uint8Array(jpeg.buffer));
      setOpenMark({ markedAt, frameFile, heading: headingAtTap, readings: snapshot.frame.readings });
    } catch (error) {
      Alert.alert('Could not capture the frame', String(error));
    } finally {
      setCapturing(false);
    }
  }

  function saveMark(fields: MarkFields) {
    if (!recorder || !openMark) return;
    recorder.addMark({ ...openMark, ...fields });
    setOpenMark(null);
  }

  function cancelMark() {
    if (recorder && openMark) recorder.discardMarkFrame(openMark.frameFile);
    setOpenMark(null);
  }

  return (
    <SafeAreaView style={styles.container}>
      <ReadingsCamera
        ref={camera}
        style={styles.camera}
        isActive={appActive && !showingSessions}
        isReading={readingText}
        onFrameReadings={onFrameReadings}
      >
        {currentReadings.map((reading, index) => (
          <View
            key={index}
            style={[
              styles.box,
              {
                left: `${reading.box.x * 100}%`,
                top: `${reading.box.y * 100}%`,
                width: `${reading.box.width * 100}%`,
                height: `${reading.box.height * 100}%`,
              },
            ]}
          >
            <Text style={styles.boxText} numberOfLines={1}>
              {reading.text}
            </Text>
          </View>
        ))}
      </ReadingsCamera>

      <View style={styles.panel}>
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {recorder
            ? `Recording: ${loggedCount} Readings logged${heading.current === null ? ', no compass heading' : ''}`
            : 'Not recording'}
        </Text>
        <View style={styles.recent} accessibilityLabel="Most recent Readings">
          {recent.length === 0 ? (
            <Text style={styles.recentText}>{recorder ? 'No Readings yet.' : 'Tap Start to read text.'}</Text>
          ) : (
            recent.map((reading, index) => (
              <Text key={index} style={styles.recentText} numberOfLines={1}>
                {reading.text}
              </Text>
            ))
          )}
        </View>
        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            // A Mark being captured needs its session, so the session can't stop until it has its frame.
            accessibilityState={{ disabled: capturing }}
            disabled={capturing}
            onPress={recorder ? stopSession : startSession}
            style={[styles.control, recorder ? styles.stop : styles.start, capturing && styles.disabled]}
          >
            <Text style={styles.controlText}>{recorder ? 'Stop' : 'Start'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Saves the current frame and opens the Mark form"
            accessibilityState={{ disabled: !recorder || capturing }}
            disabled={!recorder || capturing}
            onPress={mark}
            style={[styles.control, styles.mark, (!recorder || capturing) && styles.disabled]}
          >
            <Text style={styles.markText}>{capturing ? 'Capturing…' : 'Mark'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: recorder !== null }}
            disabled={recorder !== null}
            onPress={() => setShowingSessions(true)}
            style={[styles.control, styles.sessions, recorder !== null && styles.disabled]}
          >
            <Text style={styles.controlText}>Sessions</Text>
          </Pressable>
        </View>
      </View>

      {openMark && (
        <MarkFormSheet readingTexts={openMark.readings.map((reading) => reading.text)} onSave={saveMark} onCancel={cancelMark} />
      )}
      {showingSessions && <PastSessions store={store} onClose={() => setShowingSessions(false)} />}
    </SafeAreaView>
  );
}

/**
 * The sessions on the phone. A Debug build loaded from Metro also copies them to the laptop
 * running Metro; a Release build has no Metro, so it keeps them only on the phone.
 */
function sessionsRoot() {
  const phone = fileSystemSessionsRoot();
  const devServer = __DEV__ ? Constants.expoConfig?.hostUri : undefined;
  return devServer ? withLaptopCopy(phone, `http://${devServer}`) : phone;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#ffd60a',
  },
  boxText: {
    position: 'absolute',
    bottom: '100%',
    left: -2,
    paddingHorizontal: 4,
    color: '#000',
    fontSize: 13,
    fontWeight: '600',
    backgroundColor: '#ffd60a',
  },
  panel: {
    padding: 16,
    gap: 10,
  },
  status: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  recent: {
    height: 8 * 20,
  },
  recentText: {
    color: '#ccc',
    fontSize: 15,
    lineHeight: 20,
  },
  controls: {
    flexDirection: 'row',
    gap: 10,
  },
  control: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 10,
  },
  start: {
    backgroundColor: '#30d158',
  },
  stop: {
    backgroundColor: '#ff453a',
  },
  mark: {
    backgroundColor: '#ffd60a',
  },
  sessions: {
    borderWidth: 1,
    borderColor: '#666',
  },
  disabled: {
    opacity: 0.4,
  },
  controlText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  markText: {
    color: '#000',
    fontSize: 17,
    fontWeight: '600',
  },
});
