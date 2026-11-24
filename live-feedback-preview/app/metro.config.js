// @ts-check
const { getDefaultConfig } = require('expo/metro-config');
const { join } = require('node:path');

const { experimentSessionsMiddleware } = require('./devServer/experimentSessions');

const config = getDefaultConfig(__dirname);

// A Debug build sends its experiment sessions here as it records them (src/experiment/laptopCopy.ts).
const receiveSessions = experimentSessionsMiddleware(join(__dirname, 'experiment-sessions'));
config.server.enhanceMiddleware = (metroMiddleware) => (req, res, next) =>
  receiveSessions(req, res, () => metroMiddleware(req, res, next));

module.exports = config;
