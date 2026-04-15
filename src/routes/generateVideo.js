'use strict';

const { Router } = require('express');
const fs = require('fs');
const uploadVideo = require('../middleware/uploadVideo');
const { generateTTS } = require('../services/tts');
const { generateSRT } = require('../services/captions');
const { overlayVideoWithTTS, getAudioDuration } = require('../services/composer');
const { uploadToStorage } = require('../services/storage');

const router = Router();

/**
 * POST /generate-video
 * Multipart form fields:
 *   video — video file (MP4/MOV/WebM/etc., max UPLOAD_MAX_VIDEO_SIZE_BYTES)
 *   text  — script for TTS and burned-in captions
 *
 * Takes an existing video, replaces its audio with TTS generated from `text`,
 * and burns in captions. Output is scaled/padded to configured dimensions
 * (VIDEO_WIDTH × VIDEO_HEIGHT). Stops at the shorter of the video or TTS audio.
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

  try {
    log.info('Step 1/4 — TTS');
    const audioPath = await generateTTS(text, tmpDir);

    log.info('Step 2/4 — Probing audio duration');
    const duration = await getAudioDuration(audioPath);
    log.info({ duration: +duration.toFixed(2) }, 'Audio duration measured');

    log.info('Step 3/4 — Generating captions');
    const srtPath = generateSRT(text, duration, tmpDir);

    log.info('Step 4/4 — Composing video');
    const videoPath = await overlayVideoWithTTS(req.file.path, audioPath, srtPath, tmpDir, duration);

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
