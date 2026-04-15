'use strict';

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('../config');
const logger = require('../logger');

const { width, height, durationFallback } = config.video;
const { fontSize, primaryColour, outlineColour, position, marginV, marginH } = config.captions;

const OUTPUT_FPS = 25;
const FADE_IN_DURATION = 0.3; // seconds — applied at the start of every /generate output

// For any motion effect the source image is pre-scaled to OVERSCAN × the output
// dimensions so zoompan can crop and animate without ever upscaling above the
// original pixels. At zoom=1.0 the full overscan area is visible (slightly wider
// than the original field of view); at zoom=OVERSCAN the original framing is restored.
const OVERSCAN = 1.3;

// ---------------------------------------------------------------------------
// Caption position (ASS numpad layout)
// ---------------------------------------------------------------------------
const POSITION_MAP = {
  'bottom-left':   1,
  'bottom-center': 2,
  'bottom-right':  3,
  'middle-left':   4,
  'middle-center': 5,
  'middle-right':  6,
  'top-left':      7,
  'top-center':    8,
  'top-right':     9,
};

function resolveAlignment(pos) {
  const alignment = POSITION_MAP[pos];
  if (!alignment) {
    throw new Error(
      `Invalid CAPTION_POSITION "${pos}". Valid values: ${Object.keys(POSITION_MAP).join(', ')}`
    );
  }
  return alignment;
}

// ---------------------------------------------------------------------------
// Motion effect validation (fail-fast at startup)
// ---------------------------------------------------------------------------
const VALID_EFFECTS = ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'ken-burns', 'shake'];

/**
 * Validate an effect name. Throws with a descriptive message if invalid.
 * Used both at startup (to validate the env-var default) and per-request.
 */
function validateEffect(e) {
  if (!VALID_EFFECTS.includes(e)) {
    throw new Error(`Invalid effect "${e}". Valid values: ${VALID_EFFECTS.join(', ')}`);
  }
  return e;
}

// Validate the configured default at startup — fail fast if the env var is wrong.
validateEffect(config.video.effect);

// ---------------------------------------------------------------------------
// Video composition
// ---------------------------------------------------------------------------

/**
 * Compose the final MP4 from a still image, TTS audio, and SRT captions.
 * @param {string}  durationSeconds  Audio duration — used to pace motion effects.
 * @param {string}  [effectOverride] Per-request effect; falls back to VIDEO_EFFECT env var.
 * @returns {Promise<string>} Absolute path to the output .mp4 file
 */
function composeVideo(imagePath, audioPath, srtPath, outputDir, durationSeconds, effectOverride) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(outputDir, `${randomUUID()}.mp4`);
    const activeEffect = effectOverride ?? config.video.effect;
    const videoFilter = buildVideoFilter(srtPath, durationSeconds, activeEffect, true);

    const proc = ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop 1'])
      .input(audioPath)
      .outputOptions([
        '-map 0:v',
        '-map 1:a',
        '-shortest',
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a aac',
        '-b:a 192k',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        `-vf ${videoFilter}`,
      ])
      .output(outPath)
      .on('start', cmd => logger.debug({ cmd }, 'FFmpeg started'))
      .on('progress', p => logger.trace({ percent: Math.round(p.percent || 0) }, 'FFmpeg progress'))
      .on('end', () => {
        logger.debug({ outPath }, 'FFmpeg done');
        resolve(outPath);
      })
      .on('error', (err, _stdout, stderr) => {
        logger.error({ err: err.message, stderr }, 'FFmpeg error');
        proc.kill('SIGKILL');
        reject(err);
      });

    proc.run();
  });
}

// ---------------------------------------------------------------------------
// Filter chain builder
// ---------------------------------------------------------------------------

function buildVideoFilter(srtPath, durationSeconds, effect, fadeIn = false) {
  const hasMotion = effect !== 'none';

  // Pre-scale: 1× for static, OVERSCAN× for motion (gives zoompan room to work)
  const prescale = hasMotion ? OVERSCAN : 1;
  const scaledW  = Math.round(width  * prescale);
  const scaledH  = Math.round(height * prescale);

  const scaleFilter =
    `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease,` +
    `pad=${scaledW}:${scaledH}:(ow-iw)/2:(oh-ih)/2:black`;

  const subtitleFilter =
    `subtitles=${escapePath(srtPath)}:force_style=` +
    `'FontSize=${fontSize},` +
    `PrimaryColour=${primaryColour},` +
    `OutlineColour=${outlineColour},` +
    `BorderStyle=1,Outline=2,` +
    `Alignment=${resolveAlignment(position)},` +
    `MarginV=${marginV},` +
    `MarginH=${marginH}'`;

  // Fade placed after subtitles so captions and video fade in together
  const fadeFilter = fadeIn ? `,fade=type=in:start_time=0:duration=${FADE_IN_DURATION}` : '';

  if (!hasMotion) {
    return `${scaleFilter},${subtitleFilter}${fadeFilter}`;
  }

  const totalFrames = Math.ceil(durationSeconds * OUTPUT_FPS);
  const motionFilter = buildMotionFilter(totalFrames, effect);
  return `${scaleFilter},${motionFilter},${subtitleFilter}${fadeFilter}`;
}

/**
 * Build the zoompan filter expression for the configured effect.
 *
 * Source image is already at OVERSCAN× (e.g. 1404×2496 for 1080×1920 output).
 * zoompan crops from that oversized source and outputs at the target dimensions.
 *
 * Zoom semantics on the overscan source:
 *   z = 1.0  →  full overscan area visible (slightly wider than original)
 *   z = 1.3  →  center 1080×1920 of the 1404×2496 source (original framing)
 *
 * d=100000 is intentionally large — -shortest stops the video when audio ends,
 * so the effect never loops or freezes mid-video.
 */
function buildMotionFilter(totalFrames, effect) {
  const W = width, H = height;
  const base = `d=100000:s=${W}x${H}:fps=${OUTPUT_FPS}`;

  // Step size so the effect completes exactly over the video duration
  const zoomStep   = (0.3 / totalFrames).toFixed(6);

  switch (effect) {
    case 'zoom-in':
      // Slowly zooms in (z 1.0 → 1.3), centered
      return (
        `zoompan=` +
        `z='min(zoom+${zoomStep},1.3)':` +
        `x='iw/2-(iw/zoom/2)':` +
        `y='ih/2-(ih/zoom/2)':` +
        `${base}`
      );

    case 'zoom-out':
      // Starts at original framing (z 1.3) and slowly pulls back (→ 1.0)
      return (
        `zoompan=` +
        `z='if(eq(on,0),1.3,max(zoom-${zoomStep},1.0))':` +
        `x='iw/2-(iw/zoom/2)':` +
        `y='ih/2-(ih/zoom/2)':` +
        `${base}`
      );

    case 'pan-right':
      // Pans left-to-right at the original framing zoom level
      return (
        `zoompan=` +
        `z=1.3:` +
        `x='(iw-iw/zoom)*on/${totalFrames}':` +
        `y='(ih-ih/zoom)/2':` +
        `${base}`
      );

    case 'pan-left':
      // Pans right-to-left at the original framing zoom level
      return (
        `zoompan=` +
        `z=1.3:` +
        `x='(iw-iw/zoom)*(1-on/${totalFrames})':` +
        `y='(ih-ih/zoom)/2':` +
        `${base}`
      );

    case 'ken-burns':
      // Zoom in while drifting diagonally — a classic documentary feel.
      // Pan is bounded to half the available overscan range so it never clips.
      return (
        `zoompan=` +
        `z='min(zoom+${zoomStep},1.3)':` +
        `x='iw/2-(iw/zoom/2)+on*(iw-iw/zoom)/(2*${totalFrames})':` +
        `y='ih/2-(ih/zoom/2)+on*(ih-ih/zoom)/(2*${totalFrames})':` +
        `${base}`
      );

    case 'shake':
      // Subtle handheld-camera shake at the original framing zoom level.
      // Amplitude (8 px) is well within the OVERSCAN buffer.
      return (
        `zoompan=` +
        `z=1.3:` +
        `x='(iw-iw/zoom)/2+sin(on*0.5)*8':` +
        `y='(ih-ih/zoom)/2+cos(on*0.7)*8':` +
        `${base}`
      );

    default:
      return '';
  }
}

/**
 * Compose the final MP4 from an input video, TTS audio, and SRT captions.
 * Unlike composeVideo, the input is a real video (not a still image) so:
 *   - no -loop 1
 *   - no motion effects (the video already moves)
 *   - video is scaled/padded to the configured output dimensions
 *   - -shortest stops the output when the shorter of TTS audio or input video ends
 *
 * @param {string} videoPath     Path to the source video file
 * @param {string} audioPath     Path to the TTS .mp3 file
 * @param {string} srtPath       Path to the .srt captions file
 * @param {string} outputDir     Temp dir for the output file
 * @param {number} durationSeconds TTS audio duration (used only to size caption timing — not clamping)
 * @returns {Promise<string>} Absolute path to the output .mp4 file
 */
function overlayVideoWithTTS(videoPath, audioPath, srtPath, outputDir, durationSeconds) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(outputDir, `${randomUUID()}.mp4`);
    const videoFilter = buildVideoFilter(srtPath, durationSeconds, 'none');

    const proc = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-map 0:v',
        '-map 1:a',
        '-shortest',
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a aac',
        '-b:a 192k',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        `-vf ${videoFilter}`,
      ])
      .output(outPath)
      .on('start', cmd => logger.debug({ cmd }, 'FFmpeg started'))
      .on('progress', p => logger.trace({ percent: Math.round(p.percent || 0) }, 'FFmpeg progress'))
      .on('end', () => {
        logger.debug({ outPath }, 'FFmpeg done');
        resolve(outPath);
      })
      .on('error', (err, _stdout, stderr) => {
        logger.error({ err: err.message, stderr }, 'FFmpeg error');
        proc.kill('SIGKILL');
        reject(err);
      });

    proc.run();
  });
}

// ---------------------------------------------------------------------------
// Audio duration probe
// ---------------------------------------------------------------------------

/**
 * Get the duration of an audio file in seconds via ffprobe.
 * Falls back to VIDEO_DURATION_SECONDS if the metadata is unavailable.
 * @returns {Promise<number>}
 */
function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ffprobe timed out')),
      10_000
    );

    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(metadata.format.duration ?? durationFallback);
    });
  });
}

// ---------------------------------------------------------------------------
// Path escaping
// ---------------------------------------------------------------------------

/**
 * Escape a file path for use in FFmpeg's subtitles= filter.
 *
 * On Windows, FFmpeg's filter parser requires:
 *   1. The path wrapped in single quotes
 *   2. The drive-letter colon escaped as \: even inside the quotes
 *
 * Without quotes:      C\:/path  →  FFmpeg treats C as filename, \: as separator
 * Without escaped :    'C:/path' →  same mis-parse inside quotes
 * Correct form:        'C\:/path/file.srt'
 */
function escapePath(p) {
  return "'" + p.replace(/\\/g, '/').replace(/:/g, '\\:') + "'";
}

module.exports = { composeVideo, overlayVideoWithTTS, getAudioDuration, validateEffect, VALID_EFFECTS };
