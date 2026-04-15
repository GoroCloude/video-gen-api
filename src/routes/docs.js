'use strict';

const { Router } = require('express');
const swaggerUi = require('swagger-ui-express');
const helmet   = require('helmet');
const spec     = require('../openapi');

const router = Router();

/**
 * Serve the interactive Swagger UI at GET /api-docs.
 *
 * Helmet's default Content-Security-Policy blocks swagger-ui's inline scripts
 * and styles, so we override it for this route only — the API endpoints
 * themselves are still covered by the strict CSP applied in app.js.
 */
// Prevent browsers and proxies from caching the docs UI or the raw spec
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});

router.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'", "'unsafe-inline'"],
        styleSrc:    ["'self'", "'unsafe-inline'"],
        imgSrc:      ["'self'", 'data:'],
        connectSrc:  ["'self'"],
      },
    },
  })
);

router.use('/', swaggerUi.serve);
router.get('/', swaggerUi.setup(spec, {
  customSiteTitle: 'video-gen-api docs',
  swaggerOptions: {
    // Expand the /generate operation by default
    docExpansion: 'list',
    defaultModelsExpandDepth: 2,
    tryItOutEnabled: true,
  },
}));

// Expose the raw spec as JSON for Postman / code generators
router.get('/json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json(spec);
});

module.exports = router;
