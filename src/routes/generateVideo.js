'use strict';

const { Router } = require('express');
const fs = require('fs');
const uploadVideo = require('../middleware/uploadVideo');
const { generateTTS } = require('../services/tts');
const { generateASS, generateWordByWordASS, VALID_CAPTION_STYLES, validateCaptionStyle } = require('../services/captions');
const { overlayVideoWithTTS, getAudioDuration, validateEffect, validateCaptionPosition, resolveActiveAlignment } = require('../services/composer');
const { uploadToStorage } = require('../services/storage');
const config = require('../config');

const router = Router();

/**
 * POST /generate-video
 * Multipart form fields:
 *   video           — video file (MP4/MOV/WebM/etc., max UPLOAD_MAX_VIDEO_SIZE_BYTES)
 *   text            — script for TTS and burned-in captions
 *   effect          — optional motion effect (overrides VIDEO_EFFECT env)
 *   captionPosition — optional position: top | center | bottom
 *   captionStyle    — optional style: word-by-word | karaoke
 *
 * Takes an existing video, replaces its audio with TTS generated from `text`,
 * and burns in captions. Output is scaled/padded to configured dimensions.
 *
 * Response: { success, url, key, bucket, duration }
 */
router.post('/', uploadVideo.single('video'), async (req, res, next) => {
  const log = req.log;
  const { tmpDir } = req;

  if (!req.file) {
    return res.status(400).json({ error: 'Missing field: video' });
  }
  const text = (req.body.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Missing field: text' });
  }

  // Optional per-request effect; falls back to VIDEO_EFFECT env var
  const effectRaw = (req.body.effect || '').trim() || null;
  if (effectRaw) {
    try { validateEffect(effectRaw); } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // Optional per-request caption position: top | center | bottom
  const captionPositionRaw = (req.body.captionPosition || '').trim() || null;
  if (captionPositionRaw) {
    try { validateCaptionPosition(captionPositionRaw); } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // Optional per-request caption style; falls back to CAPTION_STYLE env var
  const captionStyleRaw = (req.body.captionStyle || '').trim() || config.captions.style;
  try { validateCaptionStyle(captionStyleRaw); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    log.info('Step 1/4 — TTS');
    const audioPath = await generateTTS(text, tmpDir);

    log.info('Step 2/4 — Probing audio duration');
    const duration = await getAudioDuration(audioPath);
    log.info({ duration: +duration.toFixed(2) }, 'Audio duration measured');

    log.info({ captionStyle: captionStyleRaw }, 'Step 3/4 — Generating captions');
    const alignmentNumber = resolveActiveAlignment(captionPositionRaw);
    const assPath = captionStyleRaw === 'word-by-word'
      ? generateWordByWordASS(text, duration, tmpDir, alignmentNumber)
      : generateASS(text, duration, tmpDir, alignmentNumber);

    log.info('Step 4/4 — Composing video');
    const videoPath = await overlayVideoWithTTS(req.file.path, audioPath, assPath, tmpDir, duration, effectRaw);

    log.info('Uploading to storage');
    const key = `generated/${req.id}.mp4`;
    const { url, bucket } = await uploadToStorage(videoPath, key);

    log.info({ key }, 'Job complete');

    return res.status(200).json({
      success: true,
      url,
      key,
      bucket,
      duration: Math.round(duration * 100) / 100,
    });

  } catch (err) {
    next(err);
  } finally {
    cleanupDir(tmpDir);
  }
});

function cleanupDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

module.exports = router;
