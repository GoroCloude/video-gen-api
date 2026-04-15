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
const config = require('../config');

const router = Router();

const MAX_URLS = 20;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB per video
const DEFAULT_TRANSITION_DURATION = 0.5;    // seconds
const OUTPUT_FPS = 25;

// xfade transitions exposed in the API.
// Full list: https://ffmpeg.org/ffmpeg-filters.html#xfade
const VALID_TRANSITIONS = [
  'none',
  'fade', 'fadeblack', 'fadewhite',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'dissolve', 'circlecrop', 'circleopen', 'circleclose',
];

/**
 * POST /combine
 * JSON body:
 *   urls               — ordered array of MP4 URLs to concatenate (2–20)
 *   transition         — optional xfade transition name (default: "none")
 *   transitionDuration — optional seconds for the transition (default: 0.5, max: 3)
 *
 * When transition is "none": uses FFmpeg concat demuxer (stream copy, very fast).
 * Otherwise: re-encodes with chained xfade (video) + acrossfade (audio) filters.
 *
 * Response: { success, url, key, bucket, duration, videoCount[, transition, transitionDuration] }
 */
router.post('/', express.json(), async (req, res, next) => {
  const log = req.log;

  // --- Validation ---
  const { urls, transition: transitionRaw, transitionDuration: tdRaw } = req.body || {};

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

  const transition = (transitionRaw || 'none').trim();
  if (!VALID_TRANSITIONS.includes(transition)) {
    return res.status(400).json({
      error: `Invalid transition "${transition}". Valid values: ${VALID_TRANSITIONS.join(', ')}`,
    });
  }

  const transitionDuration = tdRaw != null ? parseFloat(tdRaw) : DEFAULT_TRANSITION_DURATION;
  if (isNaN(transitionDuration) || transitionDuration <= 0 || transitionDuration > 3) {
    return res.status(400).json({ error: 'transitionDuration must be between 0 and 3 seconds' });
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
    let combinedPath;
    if (transition === 'none') {
      log.info('Step 2/3 — Concatenating (stream copy)');
      const concatListPath = writeConcatList(videoPaths, tmpDir);
      combinedPath = await concatVideos(concatListPath, tmpDir);
    } else {
      log.info({ transition, transitionDuration }, 'Step 2/3 — Concatenating with transitions');
      combinedPath = await concatWithTransitions(videoPaths, transition, transitionDuration, tmpDir);
    }

    const duration = await getAudioDuration(combinedPath);
    log.info({ duration: +duration.toFixed(2) }, 'Combined video duration');

    // --- Step 3: Upload ---
    log.info('Step 3/3 — Uploading to storage');
    const key = `combined/${req.id}.mp4`;
    const { url, bucket } = await uploadToStorage(combinedPath, key);

    log.info({ key }, 'Combine job complete');

    const body = {
      success:    true,
      url,
      key,
      bucket,
      duration:   Math.round(duration * 100) / 100,
      videoCount: urls.length,
    };
    if (transition !== 'none') {
      body.transition = transition;
      body.transitionDuration = transitionDuration;
    }

    return res.status(200).json(body);

  } catch (err) {
    next(err);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// Download
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

// ---------------------------------------------------------------------------
// Concat — stream copy (no transition)
// ---------------------------------------------------------------------------

/**
 * Write an FFmpeg concat demuxer list file.
 * Forward slashes only — the concat demuxer does not use the filter-graph parser.
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
 * Concatenate via the concat demuxer. Stream copy — no re-encoding, very fast.
 * Requires all inputs to share the same codec and resolution.
 */
function concatVideos(concatListPath, outputDir) {
  const outPath = path.join(outputDir, `${randomUUID()}.mp4`);
  return spawnFfmpeg([
    '-f', 'concat', '-safe', '0', '-i', concatListPath,
    '-c', 'copy', '-movflags', '+faststart', '-y', outPath,
  ], outPath);
}

// ---------------------------------------------------------------------------
// Concat — xfade + acrossfade (with transitions)
// ---------------------------------------------------------------------------

/**
 * Concatenate with xfade video transitions and acrossfade audio cross-fades.
 * Re-encodes all inputs. Uses a chained filter_complex.
 *
 * Each input stream is normalised with setpts/asetpts=PTS-STARTPTS before
 * entering the chain. Without this reset, xfade returns EINVAL (-22) because
 * every downloaded MP4 has timestamps that start from 0 relative to itself;
 * the filter cannot synchronise streams that all share the same origin.
 *
 * xfade offset math (cumulative):
 *   offset_i = Σ (duration[j] - T) for j = 0..i-1
 * Places each transition T seconds before the end of the preceding clip.
 */
async function concatWithTransitions(videoPaths, transition, transitionDuration, outputDir) {
  const T = transitionDuration;
  const n = videoPaths.length;
  const W = config.video.width;
  const H = config.video.height;

  // Probe all durations (needed to compute xfade/axfade offsets)
  const durations = await Promise.all(videoPaths.map(p => getAudioDuration(p)));

  // Cumulative offsets: offset[i] = Σ (duration[j] - T) for j = 0..i
  // Places each transition T seconds before the end of the preceding combined stream.
  const offsets = [];
  let cumOffset = 0;
  for (let i = 0; i < n - 1; i++) {
    cumOffset += durations[i] - T;
    offsets.push(+cumOffset.toFixed(4));
  }

  const filters = [];

  // Normalise every input to a consistent resolution, frame rate, pixel format,
  // and audio format. Without this, xfade returns EINVAL when inputs differ in
  // any of these properties (e.g. combining clips from different sources).
  for (let i = 0; i < n; i++) {
    filters.push(
      `[${i}:v]` +
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,` +
      `fps=${OUTPUT_FPS},format=yuv420p,` +
      `setpts=PTS-STARTPTS` +
      `[v${i}]`
    );
    // aformat ensures consistent sample rate and layout before axfade
    filters.push(
      `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`
    );
  }

  // Chain xfade filters (video)
  let prevV = 'v0';
  for (let i = 0; i < n - 1; i++) {
    const outV = i === n - 2 ? 'vout' : `vt${i}`;
    filters.push(
      `[${prevV}][v${i + 1}]xfade=transition=${transition}:duration=${T}:offset=${offsets[i]}[${outV}]`
    );
    prevV = outV;
  }

  // Chain acrossfade filters (audio).
  // Inputs are normalised to the same sample rate/format above, so acrossfade
  // chains correctly: it detects EOF on each filter output and starts the
  // crossfade T seconds before that end.
  let prevA = 'a0';
  for (let i = 0; i < n - 1; i++) {
    const outA = i === n - 2 ? 'aout' : `at${i}`;
    filters.push(`[${prevA}][a${i + 1}]acrossfade=d=${T}[${outA}]`);
    prevA = outA;
  }

  const outPath = path.join(outputDir, `${randomUUID()}.mp4`);

  return spawnFfmpeg([
    ...videoPaths.flatMap(p => ['-i', p]),
    '-filter_complex', filters.join('; '),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-y', outPath,
  ], outPath);
}

// ---------------------------------------------------------------------------
// Shared FFmpeg runner
// ---------------------------------------------------------------------------

function spawnFfmpeg(args, outPath) {
  return new Promise((resolve, reject) => {
    logger.debug({ cmd: `ffmpeg ${args.join(' ')}` }, 'FFmpeg started');

    const proc = spawn('ffmpeg', args);
    const stderrChunks = [];
    proc.stderr.on('data', chunk => stderrChunks.push(chunk));

    proc.on('close', code => {
      const stderr = Buffer.concat(stderrChunks).toString();
      if (code === 0) {
        logger.debug({ outPath }, 'FFmpeg done');
        resolve(outPath);
      } else {
        logger.error({ code, stderr }, 'FFmpeg error');
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

module.exports = { router, VALID_TRANSITIONS };
