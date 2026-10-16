import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, StyleSheet, Alert, Platform } from 'react-native';
import { Text, Button } from 'react-native-paper';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RootStackParamList } from '../types';
import {
  getLocationPermissionState,
  requestLocationPermission,
} from '../utils/locationPermission';
import { isBraveBrowser } from '../utils/webAudioUnlock';
import {
  getCameraPermissionState,
  requestCameraPermission,
} from '../utils/cameraPermission';
import {
  ensureMicrophonePermission,
  isMicrophonePermissionGranted,
} from '../utils/microphonePermission';

type Props = NativeStackScreenProps<RootStackParamList, 'Permissions'>;

/**
 * Show independent location, camera, and microphone permission controls with accessible progress
 * and denial feedback.
 */
export default function PermissionsScreen({ navigation }: Props) {
  const [locationGranted, setLocationGranted] = useState(false);
  const [cameraGranted, setCameraGranted] = useState(false);
  const [micGranted, setMicGranted] = useState(false);
  const [locationBusy, setLocationBusy] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [micBusy, setMicBusy] = useState(false);

  const allGranted = locationGranted && cameraGranted && micGranted;

  const refreshPermissionStates = useCallback(async () => {
    // Read all permission states together and synchronize the onboarding controls without
    // requesting new prompts.
    const [location, camera, mic] = await Promise.all([
      getLocationPermissionState(),
      getCameraPermissionState(),
      isMicrophonePermissionGranted(),
    ]);
    setLocationGranted(location === 'granted');
    setCameraGranted(camera === 'granted');
    setMicGranted(mic);
  }, []);

  useEffect(() => {
    // Refresh the displayed permission states when the screen is first shown.
    void refreshPermissionStates();
  }, [refreshPermissionStates]);

  /** Mark onboarding complete locally before entering the main experience. */
  async function handleContinue() {
    await AsyncStorage.setItem('onboardingComplete', 'true');
    navigation.navigate('Main');
  }

  /**
   * Request location access once per active interaction and explain denial or request failures
   * without leaving the button busy.
   */
  async function requestLocation() {
    if (locationBusy || locationGranted) return;
    setLocationBusy(true);
    try {
      const state = await requestLocationPermission();
      if (state === 'granted') {
        setLocationGranted(true);
      } else {
        const message =
          Platform.OS === 'web' && isBraveBrowser()
            ? 'Location was not enabled. In Brave, open the lion icon in the address bar and allow Location for this site, or turn off Shields for buddywalk.app.'
            : Platform.OS === 'web'
              ? 'Location was not enabled. Tap Allow when prompted, or check your browser site settings.'
              : 'Location is required for navigation features.';
        Alert.alert('Location Access Denied', message);
      }
    } catch (e) {
      console.error('requestLocation error:', e);
      Alert.alert(
        'Location Error',
        'Could not request location. Make sure you are on a secure connection (https) and try again.'
      );
    } finally {
      setLocationBusy(false);
    }
  }

  /**
   * Request camera authorization and update its control independently of location and microphone
   * permissions.
   */
  async function requestCamera() {
    if (cameraBusy || cameraGranted) return;
    setCameraBusy(true);
    try {
      const state = await requestCameraPermission();
      if (state === 'granted') {
        setCameraGranted(true);
      } else {
        Alert.alert('Camera Access Denied', 'Camera is required to capture photos and videos.');
      }
    } catch (e) {
      console.error('requestCamera error:', e);
      Alert.alert('Camera Error', 'Could not request camera access. Please try again.');
    } finally {
      setCameraBusy(false);
    }
  }

  /** Request microphone authorization and update the spoken-question permission state. */
  async function requestMic() {
    if (micBusy || micGranted) return;
    setMicBusy(true);
    try {
      const ok = await ensureMicrophonePermission();
      if (ok) {
        setMicGranted(true);
      } else {
        Alert.alert('Microphone Access Denied', 'Microphone is required to ask questions by voice.');
      }
    } catch (e) {
      console.error('requestMic error:', e);
      Alert.alert('Microphone Error', 'Could not request microphone access. Please try again.');
    } finally {
      setMicBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Scrollable so the Continue button stays reachable with zoomed / large accessibility text. */}
      <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title} variant="headlineMedium" accessibilityRole="header">
        USER AGREEMENT
      </Text>

      <View style={styles.waiverBox}>
        <Text style={styles.waiverText}>
          This app is designed to assist blind and visually impaired users in navigation. Due
          to AI limitations and GPS accuracy, the app may not always provide correct information.
          Users should not rely solely on this app.{' '}
        </Text>
        <Text
          style={styles.waiverLink}
          onPress={/* Open the waiver information without changing the stored permission decisions. */ () => navigation.navigate('Waiver')}
          accessibilityRole="link"
          accessibilityLabel="Read full waiver"
        >
          Read Full Waiver
        </Text>
      </View>

      <Text style={styles.instructions}>
        Please enable location, camera, and microphone to continue.
      </Text>

      <View style={styles.buttons}>
        <Button
          mode="contained"
          onPress={/* Start the location permission interaction from its accessible control. */ () => void requestLocation()}
          disabled={locationBusy || locationGranted}
          loading={locationBusy}
          style={[styles.button, locationGranted && styles.buttonGranted]}
          contentStyle={styles.buttonContent}
          labelStyle={[styles.buttonLabel, locationGranted && styles.buttonLabelGranted]}
          accessibilityLabel={locationGranted ? 'Location enabled' : 'Enable location access'}
          icon={locationGranted ? 'check' : 'map-marker'}
        >
          {locationGranted ? 'Location Enabled' : locationBusy ? 'Requesting…' : 'Enable Location'}
        </Button>

        <Button
          mode="contained"
          onPress={/* Start the camera permission interaction from its accessible control. */ () => void requestCamera()}
          disabled={cameraBusy || cameraGranted}
          loading={cameraBusy}
          style={[styles.button, cameraGranted && styles.buttonGranted]}
          contentStyle={styles.buttonContent}
          labelStyle={[styles.buttonLabel, cameraGranted && styles.buttonLabelGranted]}
          accessibilityLabel={cameraGranted ? 'Camera enabled' : 'Enable camera access'}
          icon={cameraGranted ? 'check' : 'camera'}
        >
          {cameraGranted ? 'Camera Enabled' : cameraBusy ? 'Requesting…' : 'Enable Camera'}
        </Button>

        <Button
          mode="contained"
          onPress={/* Start the microphone permission interaction from its accessible control. */ () => void requestMic()}
          disabled={micBusy || micGranted}
          loading={micBusy}
          style={[styles.button, micGranted && styles.buttonGranted]}
          contentStyle={styles.buttonContent}
          labelStyle={[styles.buttonLabel, micGranted && styles.buttonLabelGranted]}
          accessibilityLabel={micGranted ? 'Microphone enabled' : 'Enable microphone access'}
          icon={micGranted ? 'check' : 'microphone'}
        >
          {micGranted ? 'Microphone Enabled' : micBusy ? 'Requesting…' : 'Enable Microphone'}
        </Button>
      </View>

      {allGranted && (
        <Button
          mode="contained"
          onPress={/* Finish the permission onboarding flow from the Continue control. */ () => void handleContinue()}
          style={styles.continueButton}
          contentStyle={styles.continueButtonContent}
          labelStyle={styles.continueButtonLabel}
          accessibilityLabel="Continue to Buddy Walk"
          icon="arrow-right"
        >
          Continue
        </Button>
      )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
  },
  title: {
    color: '#fff',
    fontWeight: 'bold',
    textAlign: 'center',
    letterSpacing: 2,
    marginBottom: 16,
  },
  waiverBox: {
    borderWidth: 1,
    borderColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  waiverText: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 22,
  },
  waiverLink: {
    color: '#fff',
    fontWeight: 'bold',
    textDecorationLine: 'underline',
    marginTop: 8,
  },
  instructions: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 24,
  },
  buttons: {
    gap: 12,
  },
  button: {
    borderRadius: 40,
    backgroundColor: '#fff',
  },
  buttonGranted: {
    backgroundColor: '#2e7d32',
  },
  buttonContent: {
    paddingVertical: 8,
  },
  buttonLabel: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  buttonLabelGranted: {
    color: '#fff',
  },
  continueButton: {
    borderRadius: 40,
    backgroundColor: '#fff',
    marginTop: 'auto',
    marginBottom: 8,
  },
  continueButtonContent: {
    paddingVertical: 16,
    flexDirection: 'row-reverse',
  },
  continueButtonLabel: {
    color: '#000',
    fontSize: 22,
    fontWeight: 'bold',
    letterSpacing: 2,
  },
});
