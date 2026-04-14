'use strict';

const { Router } = require('express');
const config = require('../config');

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    tts: config.elevenlabs.apiKey ? 'elevenlabs+google-fallback' : 'google',
    video: `${config.video.width}x${config.video.height}`,
  });
});

module.exports = router;
