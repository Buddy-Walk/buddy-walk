import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TextInput,
  Alert,
  AccessibilityInfo,
  Pressable,
  Share,
  AppState,
  Platform,
} from 'react-native';
import { Text, Button, IconButton, ActivityIndicator } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeStackScreenProps } from '@react-navigation/native-stack';

import { RootStackParamList } from '../types';
import { describeApiError } from '../api/apiErrors';
import { isLocalCompanionApi } from '../api/client';
import { checkCompanionApiAvailability } from '../api/companionAvailability';
import {
  buildShareUrl,
  createCompanionSession,
  pingCompanionSession,
  stopCompanionSession,
} from '../api/companion';
import { track, Events } from '../api/telemetry';
import { buildMapsShareUrl } from '../utils/mapsShareUrl';

type Props = NativeStackScreenProps<RootStackParamList, 'Companion'>;

const ACTIVE_SESSION_KEY = '@buddywalk:companionSession:v1';
/** Heartbeat when standing still — keeps the session marked active. */
const PING_INTERVAL_MS = 15_000;
/** Minimum gap between movement-triggered pings so GPS chatter doesn't flood the server. */
const MOVEMENT_PING_MS = 4_000;

interface LiveSession {
  mode: 'live';
  token: string;
  ownerSecret: string;
  displayName?: string;
  expiresAt: string;
  startedAt: string;
}

interface MapsSession {
  mode: 'maps';
  displayName?: string;
  startedAt: string;
}

type PersistedSession = LiveSession | MapsSession;

/** Format a sharing timestamp for display, distinguishing missing and invalid values. */
function formatTime(iso?: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'unknown';
  return d.toLocaleTimeString();
}

/**
 * Explain a live-sharing backend failure and the available static-map fallback in
 * platform-appropriate language.
 */
function companionUnavailableMessage(
  reason: 'html_not_api' | 'network' | 'bad_response' | null
): string {
  if (Platform.OS === 'web') {
    if (reason === 'network') {
      return 'Live map links are unavailable. You can still share a Google Maps pin from this screen.';
    }
    return 'Live map links are unavailable right now. You can still share a Google Maps pin.';
  }
  if (reason === 'html_not_api') {
    return (
      'Live map sharing is not on this server yet. Buddy Walk will share a Google Maps pin ' +
      'instead — tap Share again after you move for an updated location.'
    );
  }
  return (
    'Live map server unreachable. Buddy Walk will share a Google Maps pin instead. ' +
    'For live tracking on a local backend, run npm run serve in mobile/ and set EXPO_PUBLIC_COMPANION_API_URL.'
  );
}

/**
 * Narrow a persisted sharing record to the live-session shape, including older records that stored
 * a token without a mode.
 */
function isLiveSession(s: PersistedSession): s is LiveSession {
  return s.mode === 'live' || 'token' in s;
}

/**
 * Choose a live viewer link or a current static map pin according to the session and backend
 * availability.
 */
function getShareUrl(
  session: PersistedSession | null,
  fix: Location.LocationObject | null,
  liveApiReady: boolean
): string | null {
  if (!session) return null;
  const useMaps = !isLiveSession(session) || !liveApiReady;
  if (useMaps) {
    if (!fix) return null;
    return buildMapsShareUrl(fix.coords.latitude, fix.coords.longitude, session.displayName);
  }
  return buildShareUrl(session.token);
}

/**
 * Manage foreground location sharing, persisted session restoration, live-server health, and
 * accessible share/stop controls.
 */
export default function CompanionScreen({ navigation }: Props) {
  const [displayName, setDisplayName] = useState('');
  const [session, setSession] = useState<PersistedSession | null>(null);
  const [working, setWorking] = useState(false);
  const [lastPingAt, setLastPingAt] = useState<string | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [companionAvailable, setCompanionAvailable] = useState<boolean | null>(null);
  const [companionUnavailableReason, setCompanionUnavailableReason] = useState<
    'html_not_api' | 'network' | 'bad_response' | null
  >(null);

  const locationSubRef = useRef<Location.LocationSubscription | null>(null);
  const lastFixRef = useRef<Location.LocationObject | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<PersistedSession | null>(null);
  const lastPingSentAtRef = useRef(0);
  const pingInFlightRef = useRef(false);

  // Keep the ref in sync so the polling loop can read the latest session
  useEffect(() => {
    // Expose the latest sharing session to asynchronous tracking and sharing callbacks.
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    // Check backend availability and restore an eligible persisted session, cancelling startup
    // work and tracking on unmount.
    let cancelled = false;

    /**
     * Restore a stored live or static-map session, validating its credentials and expiration
     * before resuming the appropriate tracker.
     */
    async function restoreSession(apiAvailable: boolean) {
      try {
        const raw = await AsyncStorage.getItem(ACTIVE_SESSION_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as {
          mode?: 'live' | 'maps';
          token?: string;
          ownerSecret?: string;
          displayName?: string;
          expiresAt?: string;
          startedAt?: string;
        };
        if (parsed.mode === 'maps') {
          const mapsSession: MapsSession = {
            mode: 'maps',
            displayName: parsed.displayName,
            startedAt: parsed.startedAt ?? new Date().toISOString(),
          };
          setSession(mapsSession);
          if (mapsSession.displayName) setDisplayName(mapsSession.displayName);
          await beginMapsTracking();
          return;
        }
        if (!parsed.token) return;

        if (!apiAvailable) {
          const mapsSession: MapsSession = {
            mode: 'maps',
            displayName: parsed.displayName,
            startedAt: parsed.startedAt ?? new Date().toISOString(),
          };
          await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(mapsSession));
          setSession(mapsSession);
          if (mapsSession.displayName) setDisplayName(mapsSession.displayName);
          await beginMapsTracking();
          return;
        }

        const live: LiveSession = {
          mode: 'live',
          token: parsed.token,
          ownerSecret: parsed.ownerSecret!,
          displayName: parsed.displayName,
          expiresAt: parsed.expiresAt!,
          startedAt: parsed.startedAt ?? new Date().toISOString(),
        };
        if (new Date(live.expiresAt).getTime() < Date.now()) {
          await AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
          return;
        }
        setSession(live);
        if (live.displayName) setDisplayName(live.displayName);
        await beginTracking(live);
      } catch (e) {
        console.warn('Failed to restore companion session:', e);
      }
    }

    (async () => {
      // Probe the companion backend before deciding which sharing mode a saved session can
      // resume.
      const { available, reason } = await checkCompanionApiAvailability();
      if (cancelled) return;
      setCompanionAvailable(available);
      setCompanionUnavailableReason(available ? null : reason === 'ok' ? null : reason);
      await restoreSession(available);
    })();

    return () => {
      // Ignore late startup results and release location-sharing resources when the screen
      // unmounts.
      cancelled = true;
      stopTracking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the OS pauses the JS interval (background), we'll catch up when
  // the app comes back to the foreground.
  useEffect(() => {
    // Subscribe to app foreground transitions so an active live session can publish a fresh
    // status.
    const sub = AppState.addEventListener('change', (state) => {
      // Refresh an active live session as soon as the user returns to the app.
      if (state === 'active' && sessionRef.current && isLiveSession(sessionRef.current)) {
        sendPingNow().catch(() => { /* Keep a failed foreground refresh from interrupting screen activation. */ });
      }
    });
    return /* Remove this app-state subscription when the screen unmounts. */ () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendPingNow = useCallback(async () => {
    // Send one authenticated location ping at a time, obtaining a fix if necessary and updating
    // the last-success/error status.
    const current = sessionRef.current;
    if (!current || !isLiveSession(current)) return;
    if (pingInFlightRef.current) return;
    let fix = lastFixRef.current;
    if (!fix) {
      try {
        fix = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        lastFixRef.current = fix;
      } catch {
        return;
      }
    }
    pingInFlightRef.current = true;
    try {
      await pingCompanionSession(current.token, current.ownerSecret, {
        lat: fix.coords.latitude,
        lon: fix.coords.longitude,
        accuracy: fix.coords.accuracy ?? undefined,
        heading: fix.coords.heading,
        speed: fix.coords.speed,
      });
      lastPingSentAtRef.current = Date.now();
      setLastPingAt(new Date().toISOString());
      setPingError(null);
    } catch (e: any) {
      console.warn('companion ping failed:', e?.message || e);
      setPingError('Could not reach the sharing server');
    } finally {
      pingInFlightRef.current = false;
    }
  }, []);

  /** Request foreground location and maintain the latest fix used when sharing a static map pin. */
  async function beginMapsTracking() {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Location permission needed',
        'Buddy Walk needs location access to share your position with your contact.'
      );
      return;
    }

    locationSubRef.current?.remove();
    locationSubRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 5,
        timeInterval: 5_000,
      },
      /** Cache the most recent fix for the next static-map share operation. */
      (loc) => {
        lastFixRef.current = loc;
      }
    );

    try {
      const fix = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      lastFixRef.current = fix;
    } catch {
      /* watch will deliver a fix */
    }
  }

  /**
   * Start live-session tracking with movement-triggered updates and periodic heartbeats, avoiding
   * overlapping position watchers.
   */
  async function beginTracking(persisted: LiveSession) {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Location permission needed',
        'Buddy Walk needs location access to share your position with your contact.'
      );
      return;
    }

    locationSubRef.current?.remove();
    locationSubRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 5,
        timeInterval: 3_000,
      },
      /** Cache the location change and send a throttled live update when the wearer moves. */
      (loc) => {
        lastFixRef.current = loc;
        // Real-time: push the new position immediately when the wearer moves,
        // throttled so GPS chatter doesn't flood the server.
        if (Date.now() - lastPingSentAtRef.current >= MOVEMENT_PING_MS) {
          sendPingNow().catch(() => { /* Allow a failed movement update to be retried by the next movement or heartbeat. */ });
        }
      }
    );

    // Heartbeat keeps the session fresh while standing still.
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      // Send a live-session heartbeat even when the phone has remained stationary.
      sendPingNow().catch(() => { /* Keep a transient heartbeat failure from stopping the sharing timer. */ });
    }, PING_INTERVAL_MS);

    // fire one immediately so the viewer gets a fix right away
    sessionRef.current = persisted;
    setTimeout(() => {
      // Publish the first live location shortly after tracking starts.
      sendPingNow().catch(() => { /* Let a failed initial ping recover through the regular sharing updates. */ });
    }, 800);
  }

  /** Release the location watcher and heartbeat timer, then discard the cached fix. */
  function stopTracking() {
    if (locationSubRef.current) {
      locationSubRef.current.remove();
      locationSubRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    lastFixRef.current = null;
  }

  /** Create and persist a static-map sharing session after obtaining an authorized location fix. */
  async function startMapsSharing() {
    await beginMapsTracking();
    if (!lastFixRef.current) {
      throw new Error('Could not get your location. Check that location access is allowed.');
    }
    const persisted: MapsSession = {
      mode: 'maps',
      displayName: displayName.trim() || undefined,
      startedAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(persisted));
    setSession(persisted);
    sessionRef.current = persisted;
    setLastPingAt(new Date().toISOString());
    setPingError(null);
    Speech.speak('Sharing started. Share your maps link with your contact.', { language: 'en-US' });
    AccessibilityInfo.announceForAccessibility('Sharing started. Share your maps link.');
    void track(Events.CompanionSessionCreated, {
      hasDisplayName: Boolean(persisted.displayName),
    });
    void promptShareAfterStart(persisted, false);
  }

  /**
   * Start a live companion session when its API is available, otherwise fall back to sharing a
   * static map pin.
   */
  async function handleStart() {
    setWorking(true);
    try {
      if (companionAvailable === true) {
        try {
          const created = await createCompanionSession(displayName);
          const persisted: LiveSession = {
            mode: 'live',
            token: created.token,
            ownerSecret: created.ownerSecret,
            displayName: created.displayName ?? displayName.trim() ?? undefined,
            expiresAt: created.expiresAt,
            startedAt: new Date().toISOString(),
          };
          await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(persisted));
          setSession(persisted);
          setLastPingAt(null);
          setPingError(null);
          Speech.speak('Sharing started.', { language: 'en-US' });
          AccessibilityInfo.announceForAccessibility('Sharing started.');
          await beginTracking(persisted);
          void track(Events.CompanionSessionCreated, {
            hasDisplayName: Boolean(persisted.displayName),
          });
          void promptShareAfterStart(persisted, true);
          return;
        } catch (e) {
          console.warn('Live companion unavailable; using maps link fallback:', e);
        }
      }
      await startMapsSharing();
    } catch (e: unknown) {
      console.error('Failed to start companion session:', e);
      Alert.alert('Could not start sharing', describeApiError(e, 'companion'));
    } finally {
      setWorking(false);
    }
  }

  /**
   * Stop local tracking and clear saved sharing state, then make a best-effort request to end any
   * live server session.
   */
  async function handleStop(silent = false) {
    const current = sessionRef.current;
    stopTracking();
    setSession(null);
    sessionRef.current = null;
    setLastPingAt(null);
    setPingError(null);
    await AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
    if (current && isLiveSession(current)) {
      try {
        await stopCompanionSession(current.token, current.ownerSecret);
      } catch (e) {
        // best-effort; server will TTL-cleanup anyway
        console.warn('stopCompanionSession failed (link will still expire):', e);
      }
    }
    if (!silent) {
      Speech.speak('Sharing ended.', { language: 'en-US' });
      AccessibilityInfo.announceForAccessibility('Sharing ended.');
    }
  }

  /**
   * Open the platform share sheet with the correct live link or static pin, returning whether
   * sharing could be launched.
   */
  async function shareSessionLink(
    current: PersistedSession,
    fix: Location.LocationObject | null,
    liveApiReady: boolean
  ) {
    const url = getShareUrl(current, fix, liveApiReady);
    if (!url) return false;
    const useMaps = !isLiveSession(current) || !liveApiReady;
    try {
      await Share.share({
        message: useMaps
          ? `Here is my location on Buddy Walk:\n${url}\n\nAsk me to share again if I have moved.`
          : `Follow my live location on Buddy Walk:\n${url}`,
        url: Platform.OS === 'ios' ? url : undefined,
        title: 'Buddy Walk — location',
      });
      void track(Events.CompanionLinkShared);
      return true;
    } catch (e) {
      console.warn('share failed:', e);
      return false;
    }
  }

  /**
   * Wait for startup UI/location readiness before automatically presenting the new session's share
   * sheet.
   */
  async function promptShareAfterStart(
    current: PersistedSession,
    liveApiReady: boolean,
    delayMs = 600
  ) {
    await new Promise(/* Allow the initial sharing confirmation to settle before opening the share sheet. */ (r) => setTimeout(r, delayMs));
    if (!sessionRef.current || sessionRef.current !== current) return;
    let fix = lastFixRef.current;
    const useMaps = !isLiveSession(current) || !liveApiReady;
    if (useMaps && !fix) {
      await new Promise(/* Allow a newly requested location fix time to arrive before building a static map link. */ (r) => setTimeout(r, 2000));
      fix = lastFixRef.current;
    }
    if (!getShareUrl(current, fix, liveApiReady)) return;
    await shareSessionLink(current, fix, liveApiReady);
  }

  /** Share the active session on demand after confirming that a usable link can be constructed. */
  async function handleShareLink() {
    if (!session) return;
    const ready = companionAvailable === true;
    const shareUrl = getShareUrl(session, lastFixRef.current, ready);
    if (!shareUrl) {
      Alert.alert('Location not ready', 'Wait a moment for GPS, then try sharing again.');
      return;
    }
    await shareSessionLink(session, lastFixRef.current, ready);
  }

  const liveApiReady = companionAvailable === true;
  const url = getShareUrl(session, lastFixRef.current, liveApiReady);
  const isMapsMode = session != null && (!isLiveSession(session) || !liveApiReady);
  const localCompanion = isLocalCompanionApi();

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <IconButton
          icon="arrow-left"
          iconColor="#fff"
          size={28}
          onPress={/* Return to the previous screen without changing the active sharing session. */ () => navigation.goBack()}
          accessibilityLabel="Back to main screen"
        />
        <Text style={styles.headerTitle} accessibilityRole="header">
          Companion Mode
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.lead}>
          Share your live location with a trusted contact. They open the link in any web
          browser — no app or account needed.
        </Text>

        {companionAvailable === false && !session && (
          <View style={styles.warnBox} accessibilityRole="alert">
            <Text style={styles.warnTitle}>Using maps link sharing</Text>
            <Text style={styles.warnText}>
              {companionUnavailableMessage(companionUnavailableReason)}
            </Text>
          </View>
        )}

        {localCompanion && companionAvailable === true && !session && (
          <View style={styles.infoBox} accessibilityRole="text">
            <Text style={styles.infoTitle}>Local live map server</Text>
            <Text style={styles.infoText}>
              Your contact must be on the same Wi‑Fi or Tailscale network to open the live map
              link. Anyone else can still use the Google Maps pin when maps mode is used.
            </Text>
          </View>
        )}

        {!session ? (
          <View style={styles.card}>
            <Text style={styles.label}>Your name (optional)</Text>
            <Text style={styles.helper}>
              Shown to whoever opens your link, e.g. "Alex – Live Location".
            </Text>
            <TextInput
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="e.g. Alex"
              placeholderTextColor="rgba(255,255,255,0.75)"
              maxLength={60}
              style={styles.input}
              accessibilityLabel="Optional display name"
            />

            <Pressable
              onPress={handleStart}
              disabled={working || companionAvailable === null}
              style={/* Render the start-sharing control's pressed and in-progress appearances. */ ({ pressed }) => [
                styles.primaryButton,
                pressed && styles.primaryButtonPressed,
                working && styles.primaryButtonDisabled,
              ]}
              accessibilityLabel="Start sharing my live location"
              accessibilityRole="button"
            >
              {working || companionAvailable === null ? (
                <ActivityIndicator color="#000" />
              ) : (
                <Text style={styles.primaryButtonLabel}>START SHARING</Text>
              )}
            </Pressable>

            <Text style={styles.fineprint}>
              The link expires automatically after 6 hours of inactivity. You can end it
              any time from this screen.
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            <View style={styles.statusRow}>
              <View style={styles.liveDot} />
              <Text style={styles.statusText}>
                {isMapsMode ? 'Sharing maps pin' : 'Sharing live'}
              </Text>
            </View>

            <Text style={styles.label}>{isMapsMode ? 'Maps link' : 'Live map link'}</Text>
            <View style={styles.linkBox} accessible accessibilityLabel={`Shareable link: ${url ?? 'waiting for GPS'}`}>
              <Text style={styles.linkText} selectable>
                {url ?? 'Waiting for GPS…'}
              </Text>
            </View>

            <Pressable
              onPress={handleShareLink}
              style={/* Render the share-link control's pressed appearance. */ ({ pressed }) => [
                styles.primaryButton,
                pressed && styles.primaryButtonPressed,
              ]}
              accessibilityLabel={isMapsMode ? 'Share maps location link' : 'Share live location link'}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonLabel}>SHARE LINK</Text>
            </Pressable>

            <View style={styles.detailsRow}>
              <Text style={styles.detailLabel}>Last location</Text>
              <Text style={styles.detailValue}>{formatTime(lastPingAt)}</Text>
            </View>
            {!isMapsMode && (
              <View style={styles.detailsRow}>
                <Text style={styles.detailLabel}>Expires</Text>
                <Text style={styles.detailValue}>
                  {formatTime((session as LiveSession).expiresAt)}
                </Text>
              </View>
            )}

            {pingError ? (
              <Text style={styles.errorText} accessibilityLiveRegion="polite">
                {pingError}
              </Text>
            ) : null}

            <Button
              mode="outlined"
              onPress={/* Stop sharing and announce the change because this was an explicit user action. */ () => handleStop(false)}
              style={styles.stopButton}
              labelStyle={styles.stopButtonLabel}
              textColor="#fff"
              accessibilityLabel="End sharing now"
            >
              END SHARING
            </Button>

            <Text style={styles.fineprint}>
              {isMapsMode
                ? 'Your contact opens the link in Google Maps. Tap Share again after you move for an updated pin.'
                : localCompanion
                  ? 'Live updates flow while Buddy Walk is open. Your contact must be on the same Wi‑Fi or Tailscale network as this server.'
                  : 'Live updates only flow while Buddy Walk is open on this device. Switching apps or locking the screen will pause updates until you come back.'}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 4,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  scroll: { padding: 20, gap: 16, flexGrow: 1 },
  lead: {
    color: '#fff',
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 4,
  },
  warnBox: {
    backgroundColor: '#3d1f1f',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#8b3a3a',
    gap: 8,
  },
  warnTitle: {
    color: '#ffb4a9',
    fontSize: 16,
    fontWeight: '700',
  },
  warnText: {
    color: '#f0d0cc',
    fontSize: 14,
    lineHeight: 21,
  },
  infoBox: {
    backgroundColor: '#1a2433',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2a4a6e',
    gap: 8,
  },
  infoTitle: {
    color: '#8aa6ff',
    fontSize: 16,
    fontWeight: '700',
  },
  infoText: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 21,
  },
  warnMono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#fff',
  },
  card: {
    backgroundColor: '#161b22',
    borderRadius: 16,
    padding: 18,
    gap: 12,
    borderWidth: 1,
    borderColor: '#2a313c',
  },
  label: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  helper: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 20,
    marginTop: -4,
  },
  input: {
    backgroundColor: '#0e1116',
    color: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#2a313c',
  },
  primaryButton: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  primaryButtonPressed: { backgroundColor: '#e0e0e0' },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonLabel: {
    color: '#000',
    fontSize: 18,
    fontWeight: 'bold',
    letterSpacing: 1.5,
  },
  fineprint: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 6,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  liveDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#2ecc71',
  },
  statusText: {
    color: '#2ecc71',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  linkBox: {
    backgroundColor: '#0e1116',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#2a313c',
  },
  linkText: { color: '#8aa6ff', fontSize: 15 },
  detailsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  detailLabel: { color: '#fff', fontSize: 14 },
  detailValue: { color: '#fff', fontSize: 14, fontWeight: '600' },
  errorText: { color: '#ff8a8a', fontSize: 14 },
  stopButton: {
    borderRadius: 14,
    borderColor: '#fff',
    marginTop: 4,
  },
  stopButtonLabel: {
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: 1.2,
  },
});
