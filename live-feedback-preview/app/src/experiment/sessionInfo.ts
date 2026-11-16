import * as Application from 'expo-application';
import * as Device from 'expo-device';

import type { SessionInfo } from './session';

export function currentSessionInfo(): SessionInfo {
  return {
    device: { model: Device.modelName, osVersion: Device.osVersion },
    app: { version: Application.nativeApplicationVersion, build: Application.nativeBuildVersion },
  };
}
