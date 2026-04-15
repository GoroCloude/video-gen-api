'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');
const generateRoute      = require('./routes/generate');
const generateVideoRoute = require('./routes/generateVideo');
const { router: combineRoute } = require('./routes/combine');
const healthRoute        = require('./routes/health');
const docsRoute          = require('./routes/docs');

const app = express();

// Trust Cloudflare / reverse-proxy headers so rate limiting identifies clients by real IP
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// Attach a unique ID and child logger to every request
app.use((req, _res, next) => {
  req.id  = randomUUID();
  req.log = logger.child({ reqId: req.id, method: req.method, url: req.url });
  req.log.info('Request received');
  next();
});

// Rate limiting — applied only to the expensive /generate endpoint
const limiter = rateLimit({
  windowMs:         config.rateLimit.windowMs,
  max:              config.rateLimit.maxRequests,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many requests — please try again later' },
});

app.post('/generate',       limiter);
app.post('/generate-video', limiter);
app.post('/combine',        limiter);

// Routes
app.use('/generate',       generateRoute);
app.use('/generate-video', generateVideoRoute);
app.use('/combine',        combineRoute);
app.use('/health',   healthRoute);
app.use('/api-docs', docsRoute);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler — also handles multer errors and any unhandled next(err)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Clean up any temp dir that multer created before the route handler ran
  if (req.tmpDir) {
    try { fs.rmSync(req.tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const message =
    err.code === 'LIMIT_FILE_SIZE'
      ? `Image too large (max ${Math.round(config.upload.maxFileSizeBytes / 1024 / 1024)} MB)`
      : err.message || 'Internal server error';

  const log = req.log || logger;
  if (status >= 500) {
    log.error({ err }, 'Unhandled error');
  } else {
    log.warn({ status, message }, 'Client error');
  }

  res.status(status).json({ error: message });
});

module.exports = app;
