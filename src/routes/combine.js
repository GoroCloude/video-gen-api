'use strict';

const { Router } = require('express');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const { getAudioDuration } = require('../services/composer');
const { uploadToStorage } = require('../services/storage');
const logger = require('../logger');

const router = Router();

const MAX_URLS = 20;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB per video

/**
 * POST /combine
 * JSON body: { "urls": ["https://...", "https://...", ...] }
 *
 * Downloads each video, concatenates them with FFmpeg's concat demuxer,
 * uploads the result to MinIO, and returns a presigned URL.
 *
 * All input videos must have compatible codecs/resolution (all videos produced
 * by this API qualify). Uses stream copy (-c copy) — no re-encoding.
 */
router.post('/', express.json(), async (req, res, next) => {
  const log = req.log;

  // --- Validation ---
  const { urls } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Missing field: urls (must be a non-empty array)' });
  }
  if (urls.length < 2) {
    return res.status(400).json({ error: 'At least 2 URLs are required to combine' });
  }
  if (urls.length > MAX_URLS) {
    return res.status(400).json({ error: `Too many URLs — maximum is ${MAX_URLS}` });
  }
  for (let i = 0; i < urls.length; i++) {
    if (typeof urls[i] !== 'string' || !urls[i].trim()) {
      return res.status(400).json({ error: `urls[${i}] must be a non-empty string` });
    }
    try {
      const u = new URL(urls[i]);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return res.status(400).json({ error: `urls[${i}] must use http or https` });
      }
    } catch {
      return res.status(400).json({ error: `urls[${i}] is not a valid URL` });
    }
  }

  // --- Setup temp dir ---
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcombine-'));

  try {
    // --- Step 1: Download all videos in parallel ---
    log.info({ count: urls.length }, 'Step 1/3 — Downloading videos');
    const videoPaths = await Promise.all(
      urls.map((url, i) => downloadVideo(url, path.join(tmpDir, `input-${i}.mp4`), log))
    );
    log.info('Downloads complete');

    // --- Step 2: Concatenate ---
    log.info('Step 2/3 — Concatenating videos');
    const concatListPath = writeConcatList(videoPaths, tmpDir);
    const combinedPath   = await concatVideos(concatListPath, tmpDir);

    const duration = await getAudioDuration(combinedPath);
    log.info({ duration: +duration.toFixed(2) }, 'Combined video duration');

    // --- Step 3: Upload ---
    log.info('Step 3/3 — Uploading to storage');
    const key = `combined/${req.id}.mp4`;
    const { url, bucket } = await uploadToStorage(combinedPath, key);

    log.info({ key }, 'Combine job complete');

    return res.status(200).json({
      success:    true,
      url,
      key,
      bucket,
      duration:   Math.round(duration * 100) / 100,
      videoCount: urls.length,
    });

  } catch (err) {
    next(err);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stream-download a URL to destPath. Rejects on HTTP error, timeout, or size limit.
 */
async function downloadVideo(url, destPath, log) {
  log.debug({ url, destPath }, 'Downloading video');

  let response;
  try {
    response = await axios.get(url, {
      responseType:     'stream',
      timeout:          DOWNLOAD_TIMEOUT_MS,
      maxContentLength: MAX_VIDEO_BYTES,
      maxBodyLength:    MAX_VIDEO_BYTES,
    });
  } catch (err) {
    const status = err.response?.status;
    throw Object.assign(
      new Error(`Failed to download video (${url}): ${status ? `HTTP ${status}` : err.message}`),
      { status: 400 }
    );
  }

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on('finish', () => resolve(destPath));
    writer.on('error', reject);
    response.data.on('error', reject);
  });
}

/**
 * Write an FFmpeg concat demuxer list file and return its path.
 * Paths use forward slashes only — the concat demuxer file parser does not
 * use the filter-graph parser, so \: escaping is NOT needed (and would break it).
 */
function writeConcatList(videoPaths, tmpDir) {
  const listPath = path.join(tmpDir, 'concat.txt');
  const content = videoPaths
    .map(p => `file '${p.replace(/\\/g, '/')}'`)
    .join('\n');
  fs.writeFileSync(listPath, content, 'utf8');
  return listPath;
}

/**
 * Concatenate the videos listed in concatListPath using the concat demuxer.
 * Uses stream copy (-c copy) — no re-encoding, very fast.
 *
 * Uses child_process.spawn instead of fluent-ffmpeg to guarantee the correct
 * argument order: -f concat and -safe 0 must appear before -i on the command line.
 *
 * @returns {Promise<string>} Path to the output .mp4 file
 */
function concatVideos(concatListPath, outputDir) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(outputDir, `${randomUUID()}.mp4`);

    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y',
      outPath,
    ];

    logger.debug({ cmd: `ffmpeg ${args.join(' ')}` }, 'FFmpeg concat started');

    const proc = spawn('ffmpeg', args);
    const stderrChunks = [];
    proc.stderr.on('data', chunk => stderrChunks.push(chunk));

    proc.on('close', code => {
      const stderr = Buffer.concat(stderrChunks).toString();
      if (code === 0) {
        logger.debug({ outPath }, 'FFmpeg concat done');
        resolve(outPath);
      } else {
        logger.error({ code, stderr }, 'FFmpeg concat error');
        // Surface the last meaningful FFmpeg error line
        const errLine = stderr.split('\n').filter(l => /error/i.test(l)).slice(-3).join(' | ');
        reject(new Error(`ffmpeg exited with code ${code}: ${errLine || stderr.slice(-300)}`));
      }
    });

    proc.on('error', err => {
      logger.error({ err: err.message }, 'Failed to spawn ffmpeg');
      reject(err);
    });
  });
}

module.exports = router;
