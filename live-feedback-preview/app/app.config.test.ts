import { describe, expect, test } from 'bun:test';

function resolvedConfig(appVariant?: string) {
  const { APP_VARIANT: _ignored, ...inherited } = process.env;
  // EXPO_NO_DOTENV stops a local .env from setting APP_VARIANT behind the test's back.
  const env = { ...inherited, EXPO_NO_DOTENV: '1', ...(appVariant && { APP_VARIANT: appVariant }) };

  const result = Bun.spawnSync(['bun', 'expo', 'config', '--json', '--type', 'public'], {
    cwd: import.meta.dir,
    env,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

describe('app variant', () => {
  test('defaults to the development variant', () => {
    const config = resolvedConfig();

    expect(config.ios.bundleIdentifier).toBe('com.buddywalk.live-feedback-preview.dev');
    expect(config.name).toBe('BW Live Dev');
  });

  test('release variant uses the TestFlight bundle ID and name', () => {
    const config = resolvedConfig('release');

    expect(config.ios.bundleIdentifier).toBe('com.buddywalk.live-feedback-preview');
    expect(config.name).toBe('BW Live');
  });
});
