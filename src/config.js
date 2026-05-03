'use strict';

/**
 * Centralized, validated configuration.
 * Throws at require-time if any required env var is missing — fail fast at startup.
 */

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable "${name}" is not set`);
  return value;
}

function optional(name, fallback) {
  return process.env[name] || fallback;
}

const config = Object.freeze({
  port: parseInt(optional('PORT', '3000'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  elevenlabs: {
    apiKey:  optional('ELEVENLABS_API_KEY', ''),
    voiceId: optional('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM'),
    timeoutMs: parseInt(optional('ELEVENLABS_TIMEOUT_MS', '30000'), 10),
  },

  google: {
    languageCode: optional('GOOGLE_TTS_LANGUAGE_CODE', 'en-US'),
    voiceName:    optional('GOOGLE_TTS_VOICE_NAME', 'en-US-Neural2-C'),
  },

  minio: {
    endpoint:  required('MINIO_ENDPOINT'),
    accessKey: required('MINIO_ACCESS_KEY'),
    secretKey: required('MINIO_SECRET_KEY'),
    bucket:    optional('MINIO_BUCKET', 'videos'),
    region:    optional('MINIO_REGION', 'us-east-1'),
    // Public base URL returned in API responses (may differ from the internal upload endpoint).
    // E.g. https://minio.shumov.eu — the bucket/key are appended automatically.
    // Defaults to MINIO_ENDPOINT if not set.
    publicUrl: optional('MINIO_PUBLIC_URL', ''),
  },

  video: {
    width:            parseInt(optional('VIDEO_WIDTH', '1080'), 10),
    height:           parseInt(optional('VIDEO_HEIGHT', '1920'), 10),
    durationFallback: parseFloat(optional('VIDEO_DURATION_SECONDS', '10')),
    // Motion effect applied to the still image during encoding.
    // Valid: none | zoom-in | zoom-out | pan-left | pan-right | ken-burns | shake
    effect: optional('VIDEO_EFFECT', 'none'),
  },

  captions: {
    fontSize: parseInt(optional('CAPTION_FONT_SIZE', '7'), 10),
    // Colours are in ASS hex format (&H00BBGGRR). Override via CAPTION_PRIMARY_COLOUR / CAPTION_OUTLINE_COLOUR.
    primaryColour:  optional('CAPTION_PRIMARY_COLOUR',  '&H00FFFFFF'),  // white  — spoken/highlighted words
    outlineColour:  optional('CAPTION_OUTLINE_COLOUR',  '&H00000000'),  // black  — text outline
    // Karaoke fill colour: the dim colour shown for not-yet-spoken words.
    // Progressively replaced by primaryColour as speech reaches each word.
    karaokeColour:  optional('CAPTION_KARAOKE_COLOUR',  '&H00808080'),  // gray   — unspoken words
    // Caption rendering style:
    //   word-by-word — one word on screen at a time, appearing for its spoken duration
    //   karaoke      — 8-word chunks visible simultaneously; words fill from dim to bright as audio progresses
    style: optional('CAPTION_STYLE', 'word-by-word'),
    // Position uses numpad layout: bottom-left=1, bottom-center=2, bottom-right=3,
    // middle-left=4, middle-center=5, middle-right=6, top-left=7, top-center=8, top-right=9
    position: optional('CAPTION_POSITION', 'bottom-center'),
    marginV: parseInt(optional('CAPTION_MARGIN_V', '80'), 10),   // vertical margin in pixels
    marginH: parseInt(optional('CAPTION_MARGIN_H', '10'), 10),   // horizontal margin in pixels
    fontName: optional('CAPTION_FONT_NAME', 'Arial'),
  },

  upload: {
    maxFileSizeBytes:      parseInt(optional('UPLOAD_MAX_FILE_SIZE_BYTES',       String(20  * 1024 * 1024)), 10),
    maxVideoFileSizeBytes: parseInt(optional('UPLOAD_MAX_VIDEO_SIZE_BYTES', String(500 * 1024 * 1024)), 10),
  },

  rateLimit: {
    windowMs:  parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10),
    maxRequests: parseInt(optional('RATE_LIMIT_MAX', '10'), 10),
  },
});

module.exports = config;
