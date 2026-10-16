/** @type {import('expo/metro-config').MetroConfig} */
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const WEB_ONLY_MODULES = new Set([
  'web-speech-cognitive-services',
  'microsoft-cognitiveservices-speech-sdk',
]);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Resolve native imports without bundling browser-only packages; delegate every other import
  // to Metro.
  if (platform !== 'web' && WEB_ONLY_MODULES.has(moduleName)) {
    return { type: 'empty' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
