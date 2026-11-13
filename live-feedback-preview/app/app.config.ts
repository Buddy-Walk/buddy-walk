import type { ExpoConfig } from 'expo/config';

// APP_VARIANT=release builds the TestFlight app; anything else builds the development app.
// Never sign the release variant with a personal Apple ID: the bundle ID would be
// registered to that person, and the team account could no longer use it.
const variants = {
  development: {
    name: 'BW Live Dev',
    bundleIdentifier: 'com.buddywalk.live-feedback-preview.dev',
  },
  release: {
    name: 'BW Live',
    bundleIdentifier: 'com.buddywalk.live-feedback-preview',
  },
};

const variant = process.env.APP_VARIANT === 'release' ? variants.release : variants.development;

const config: ExpoConfig = {
  name: variant.name,
  slug: 'live-feedback-preview',
  version: '1.0.0',
  platforms: ['ios'],
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark',
  ios: {
    bundleIdentifier: variant.bundleIdentifier,
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
};

export default config;
