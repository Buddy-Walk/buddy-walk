import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

const INSTALL_ID_KEY = '@buddywalk:installId';

/**
 * Anonymous, persistent identifier for this app install. It contains no PII and
 * is only used to group usage events and feedback from the same device during
 * testing. Generated once and reused across launches.
 */
let cachedInstallId: string | null = null;

/**
 * Generate an installation/session identifier without making native crypto availability a startup
 * requirement.
 */
function genId(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    // Extremely defensive fallback if native crypto is unavailable.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Reuse the persisted installation ID across launches, or create a process-local fallback if
 * AsyncStorage cannot be read or written.
 */
export async function getInstallId(): Promise<string> {
  if (cachedInstallId) return cachedInstallId;
  try {
    const existing = await AsyncStorage.getItem(INSTALL_ID_KEY);
    if (existing && existing.trim().length > 0) {
      cachedInstallId = existing;
      return existing;
    }
    const created = genId();
    await AsyncStorage.setItem(INSTALL_ID_KEY, created);
    cachedInstallId = created;
    return created;
  } catch {
    // If storage fails we still return a per-process id so events stay grouped
    // within this launch.
    if (!cachedInstallId) cachedInstallId = genId();
    return cachedInstallId;
  }
}

/**
 * Identifier for the current app launch. Regenerated each cold start so the team
 * can see how long a single testing session ran and which events belong to it.
 */
export const sessionId = genId();

export const appVersion: string =
  Constants.expoConfig?.version ??
  (Constants.expoConfig?.extra?.appVersion as string | undefined) ??
  '0.0.0';

export const platform: string = Platform.OS;
