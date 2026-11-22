import { transformFileSync } from '@babel/core';
import { createRequire } from 'node:module';

/**
 * Loads a source file compiled the way Metro compiles it for the phone, with babel-preset-expo
 * and so the worklets plugin. Bun runs TypeScript without that plugin, so only a module loaded
 * this way shows what the plugin does to it, such as a worklet that calls a worklet declared
 * further down the file.
 */
export function loadAsMetroBundles(path: string): unknown {
  const result = transformFileSync(path, {
    babelrc: false,
    configFile: false,
    presets: ['babel-preset-expo'],
    caller: { name: 'metro', bundler: 'metro', platform: 'ios', isDev: true } as never,
  });
  if (!result?.code) throw new Error(`Babel gave no code for ${path}`);

  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.code)(module, module.exports, createRequire(path));
  return module.exports;
}
