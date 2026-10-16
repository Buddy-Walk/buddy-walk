/** Loads `.env` if present; otherwise uses buddy-walk-default-api.json. */
require('dotenv').config();

const appJson = require('./app.json');
const defaultApi = require('./buddy-walk-default-api.json');

const easProfile = process.env.EAS_BUILD_PROFILE;
const isStoreBuild = easProfile === 'production' || easProfile === 'preview';

const LEGACY_HOSTS = defaultApi.legacyApiHosts ?? ['buddywalk.app'];

/**
 * Canonicalize an API origin so callers can append their own /api path without duplicate slashes
 * or suffixes.
 */
function normalizeApiRoot(raw) {
  return raw.replace(/\/+$/, '').replace(/\/api$/i, '');
}

/**
 * Extract a case-insensitive hostname from a configured URL; return null when the value cannot be
 * parsed.
 */
function hostnameOf(root) {
  try {
    const url = root.match(/^https?:\/\//i) ? root : `https://${root}`;
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Identify retired API hosts before production configuration can embed one in a mobile build. */
function isLegacyHost(root) {
  const host = hostnameOf(root);
  if (!host) return false;
  return LEGACY_HOSTS.some(/* Compare the configured host with each normalized entry in the retired-host list. */ (legacy) => host === legacy.replace(/^www\./i, '').toLowerCase());
}

/** Never bake buddywalk.app (or other legacy hosts) into TestFlight builds. */
function applyOwnedApiHostGuardrail(root) {
  const owned = normalizeApiRoot(defaultApi.apiRoot);
  if (!root || isLegacyHost(root)) return owned;
  return normalizeApiRoot(root);
}

// EAS TestFlight builds must not bake in a developer's LAN/Tailscale .env overrides.
if (process.env.EAS_BUILD === 'true' && isStoreBuild) {
  delete process.env.EXPO_PUBLIC_API_URL;
  delete process.env.EXPO_PUBLIC_COMPANION_API_URL;
  delete process.env.EXPO_PUBLIC_COMPANION_SHARE_URL;
}

const resolvedApiRoot = applyOwnedApiHostGuardrail(
  (typeof process.env.EXPO_PUBLIC_API_URL === 'string' &&
    process.env.EXPO_PUBLIC_API_URL.trim()) ||
    defaultApi.apiRoot
);

const bypassAuth =
  typeof process.env.EXPO_PUBLIC_BYPASS_AUTH === 'string' &&
  ['1', 'true', 'yes'].includes(process.env.EXPO_PUBLIC_BYPASS_AUTH.trim().toLowerCase());

module.exports = {
  expo: {
    ...appJson.expo,
    extra: {
      ...(appJson.expo.extra ?? {}),
      eas: {
        projectId: '3bd29606-f38c-40be-aa61-9ff255f47deb',
      },
      buddyWalkApiUrl: resolvedApiRoot,
      bypassAuth,
      firebase: {
        apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
        authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
        projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
        storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
      },
    },
  },
};
