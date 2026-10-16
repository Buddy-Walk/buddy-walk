import { Alert, Linking, Platform } from 'react-native';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';

/** True when mic access is already granted (no prompt). */
export async function isMicrophonePermissionGranted(): Promise<boolean> {
  if (Platform.OS === 'web') {
    try {
      if (navigator.permissions?.query) {
        const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        return perm.state === 'granted';
      }
    } catch {
      /* Safari */
    }
    return false;
  }
  const current = await getRecordingPermissionsAsync();
  return current.granted;
}

/** Request mic access before recording (web uses getUserMedia; native uses expo-audio). */
export async function ensureMicrophonePermission(): Promise<boolean> {
  if (Platform.OS === 'web') {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(/* Release the temporary audio track opened only to obtain microphone permission. */ (track) => track.stop());
      return true;
    } catch {
      return false;
    }
  }

  const current = await getRecordingPermissionsAsync();
  if (current.granted) return true;

  if (current.canAskAgain) {
    const requested = await requestRecordingPermissionsAsync();
    if (requested.granted) return true;
  }

  Alert.alert(
    'Microphone permission required',
    'Buddy Walk needs microphone access for Tap to Ask. Enable it in Settings.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Open Settings', onPress: /* Open device settings so the user can grant microphone access after an earlier denial. */ () => Linking.openSettings() },
    ]
  );
  return false;
}
