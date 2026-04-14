'use strict';

// Load .env before anything else — config.js reads process.env at require-time
require('dotenv').config();

// Config validates required env vars and throws immediately if any are missing
const config = require('./config');
const app    = require('./app');
const logger = require('./logger');

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, tts: config.elevenlabs.apiKey ? 'elevenlabs+google' : 'google' },
    'video-gen-api started'
  );
});

// Catch unhandled rejections and exceptions — log them before exiting
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

// Graceful shutdown — let in-flight requests finish
function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    logger.warn('Forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
