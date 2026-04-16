'use strict';

const { Router } = require('express');
const fs = require('fs');
const upload = require('../middleware/upload');
const { generateTTS } = require('../services/tts');
const { generateSRT } = require('../services/captions');
const { composeVideo, getAudioDuration, validateEffect, validateCaptionPosition } = require('../services/composer');
const { uploadToStorage } = require('../services/storage');

const router = Router();

/**
 * POST /generate
 * Multipart form fields:
 *   image  — image file (JPEG/PNG, max configurable MB)
 *   text   — script for TTS and burned-in captions
 *
 * Response: { success, url, key, bucket, duration, expiresIn }
 */
router.post('/', upload.single('image'), async (req, res, next) => {
  const log = req.log;
  const { tmpDir } = req;

  if (!req.file) {
    return res.status(400).json({ error: 'Missing field: image' });
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

  const generatedFiles = [];

  try {
    log.info('Step 1/4 — TTS');
    const audioPath = await generateTTS(text, tmpDir);
    generatedFiles.push(audioPath);

    log.info('Step 2/4 — Probing audio duration');
    const duration = await getAudioDuration(audioPath);
    log.info({ duration: +duration.toFixed(2) }, 'Audio duration measured');

    log.info('Step 3/4 — Generating captions');
    const srtPath = generateSRT(text, duration, tmpDir);
    generatedFiles.push(srtPath);

    log.info('Step 4/4 — Composing video');
    const videoPath = await composeVideo(req.file.path, audioPath, srtPath, tmpDir, duration, effectRaw, captionPositionRaw);
    generatedFiles.push(videoPath);

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
    // Always clean up the entire temp dir — runs on both success and failure paths
    cleanupDir(tmpDir);
  }
});

function cleanupDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Non-fatal: log at debug level and continue
  }
}

module.exports = router;
