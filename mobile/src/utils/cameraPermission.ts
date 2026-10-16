import { Platform } from 'react-native';
import { Camera } from 'expo-camera';

export type PermissionState = 'granted' | 'denied';

/**
 * Request camera permission through the current platform and release any temporary browser stream
 * used to trigger its permission prompt.
 */
export async function requestCameraPermission(): Promise<PermissionState> {
  if (Platform.OS === 'web') {
    if (!navigator.mediaDevices?.getUserMedia) return 'denied';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(/* Stop the temporary permission-check track so it does not keep the camera active. */ (t) => t.stop());
      return 'granted';
    } catch {
      return 'denied';
    }
  }

  const { status } = await Camera.requestCameraPermissionsAsync();
  return status === 'granted' ? 'granted' : 'denied';
}

/**
 * Read camera authorization without opening a new prompt, preserving the undetermined state when
 * the platform cannot report a decision.
 */
export async function getCameraPermissionState(): Promise<PermissionState | 'undetermined'> {
  if (Platform.OS === 'web') {
    try {
      if (navigator.permissions?.query) {
        const perm = await navigator.permissions.query({ name: 'camera' as PermissionName });
        if (perm.state === 'granted') return 'granted';
        if (perm.state === 'denied') return 'denied';
      }
    } catch {
      /* Safari */
    }
    return 'undetermined';
  }

  const { status } = await Camera.getCameraPermissionsAsync();
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  return 'undetermined';
}
