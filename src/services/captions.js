'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('../config');
const logger = require('../logger');

const WORDS_PER_CUE = 8;

const VALID_CAPTION_STYLES = ['word-by-word', 'karaoke'];

function validateCaptionStyle(style) {
  if (!VALID_CAPTION_STYLES.includes(style)) {
    throw new Error(
      `Invalid captionStyle "${style}". Valid values: ${VALID_CAPTION_STYLES.join(', ')}`
    );
  }
  return style;
}

/**
 * Build an SRT subtitle file from text and a known audio duration.
 * Splits text into chunks of WORDS_PER_CUE words distributed evenly over the duration.
 * @returns {string} Absolute path to the saved .srt file
 */
function generateSRT(text, audioDurationSeconds, outputDir) {
  const words = text.trim().split(/\s+/);
  const cues = [];
  for (let i = 0; i < words.length; i += WORDS_PER_CUE) {
    cues.push(words.slice(i, i + WORDS_PER_CUE).join(' '));
  }

  const cueDuration = audioDurationSeconds / cues.length;
  const lines = cues.flatMap((cue, idx) => [
    String(idx + 1),
    `${srtTimestamp(idx * cueDuration)} --> ${srtTimestamp(Math.min((idx + 1) * cueDuration, audioDurationSeconds))}`,
    cue,
    '',
  ]);

  const outPath = path.join(outputDir, `${randomUUID()}.srt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  logger.debug({ cues: cues.length, outPath }, 'SRT generated');
  return outPath;
}

/**
 * Generate an ASS subtitle file where each word appears alone for its share
 * of the audio duration. Only the current word is on screen at any time —
 * the "word-by-word" or TikTok-style caption effect.
 *
 * @param {string} text
 * @param {number} audioDurationSeconds
 * @param {string} outputDir
 * @param {number} alignmentNumber  ASS numpad alignment (1–9)
 * @param {number} [fontSizeOverride]  Per-request font size; falls back to CAPTION_FONT_SIZE env var
 * @returns {string} Absolute path to the saved .ass file
 */
function generateWordByWordASS(text, audioDurationSeconds, outputDir, alignmentNumber, fontSizeOverride, fontNameOverride) {
  const { fontSize: defaultFontSize, primaryColour, outlineColour, marginV, marginH, fontName: defaultFontName } = config.captions;
  const fontSize = fontSizeOverride ?? defaultFontSize;
  const fontName = fontNameOverride ?? defaultFontName;

  const words = sanitizeAssText(text).trim().split(/\s+/).filter(Boolean);
  const totalDurationCs = Math.round(audioDurationSeconds * 100);
  const perWordDurationRaw = totalDurationCs / words.length;

  const header = buildASSHeader(fontName, fontSize, primaryColour, '&HFF000000', outlineColour, alignmentNumber, marginH, marginV);

  const dialogues = words.map((word, idx) => {
    const startCs = Math.round(idx * perWordDurationRaw);
    const endCs   = idx === words.length - 1
      ? totalDurationCs
      : Math.round((idx + 1) * perWordDurationRaw);
    // {\an N} inline alignment override — always honoured by libass.
    return `Dialogue: 0,${assTimestampFromCs(startCs)},${assTimestampFromCs(endCs)},Default,,0,0,0,,{\\an${alignmentNumber}}${word}`;
  });

  const outPath = path.join(outputDir, `${randomUUID()}.ass`);
  fs.writeFileSync(outPath, [header, ...dialogues].join('\n'), 'utf8');
  logger.debug({ words: words.length, alignmentNumber, outPath }, 'ASS word-by-word generated');
  return outPath;
}

/**
 * Build an ASS subtitle file with a progressive karaoke highlight effect.
 *
 * Words are grouped into WORDS_PER_CUE-word chunks. Within each chunk all
 * words are visible simultaneously: unspoken words show in karaokeColour
 * (dim), and each word progressively fills to primaryColour as audio reaches
 * it, using the ASS \kf (karaoke fill) tag.
 *
 * Using ASS (instead of SRT + force_style) is required for reliable caption
 * positioning — libass ignores force_style Alignment for SRT inputs.
 *
 * @param {string} text
 * @param {number} audioDurationSeconds
 * @param {string} outputDir
 * @param {number} alignmentNumber  ASS numpad alignment (1–9)
 * @param {number} [fontSizeOverride]  Per-request font size; falls back to CAPTION_FONT_SIZE env var
 * @returns {string} Absolute path to the saved .ass file
 */
function generateASS(text, audioDurationSeconds, outputDir, alignmentNumber, fontSizeOverride, fontNameOverride) {
  const { fontSize: defaultFontSize, primaryColour, outlineColour, karaokeColour, marginV, marginH, fontName: defaultFontName } = config.captions;
  const fontSize = fontSizeOverride ?? defaultFontSize;
  const fontName = fontNameOverride ?? defaultFontName;

  const words = sanitizeAssText(text).trim().split(/\s+/).filter(Boolean);

  const cues = [];
  for (let i = 0; i < words.length; i += WORDS_PER_CUE) {
    cues.push(words.slice(i, i + WORDS_PER_CUE));
  }

  const totalDurationCs = Math.round(audioDurationSeconds * 100);
  // Floating-point chunk boundaries are rounded to integer cs at each boundary
  // so timestamps and \kf durations stay on the same centisecond grid.
  const chunkDurationRaw = totalDurationCs / cues.length;

  // SecondaryColour = dim/unspoken word colour (used by \kf karaoke fill).
  const header = buildASSHeader(fontName, fontSize, primaryColour, karaokeColour, outlineColour, alignmentNumber, marginH, marginV);

  const dialogues = cues.map((chunkWords, idx) => {
    // Work in integer centiseconds to avoid floating-point drift between
    // Dialogue timestamps and the sum of \kf durations within the cue.
    const startCs = Math.round(idx * chunkDurationRaw);
    const endCs   = idx === cues.length - 1
      ? totalDurationCs
      : Math.round((idx + 1) * chunkDurationRaw);
    const cueCs   = endCs - startCs;

    // Distribute cue duration evenly; last word absorbs any remainder so the
    // sum of all \kf values equals the Dialogue event duration exactly.
    const perWordCs = Math.max(1, Math.floor(cueCs / chunkWords.length));

    const karaokeWords = chunkWords.map((word, wi) => {
      const isLast = wi === chunkWords.length - 1;
      const cs = isLast
        ? Math.max(1, cueCs - perWordCs * (chunkWords.length - 1))
        : perWordCs;
      // {\an N} inline alignment override on the first word (always honoured by
      // libass regardless of the Style Alignment field or FFmpeg version).
      // \kf = karaoke fill: word progressively fills from SecondaryColour to
      // PrimaryColour over `cs` centiseconds, then stays at PrimaryColour.
      const tag = wi === 0
        ? `{\\an${alignmentNumber}\\kf${cs}}`
        : `{\\kf${cs}}`;
      return `${tag}${word}`;
    });

    return `Dialogue: 0,${assTimestampFromCs(startCs)},${assTimestampFromCs(endCs)},Default,,0,0,0,,${karaokeWords.join(' ')}`;
  });

  const outPath = path.join(outputDir, `${randomUUID()}.ass`);
  fs.writeFileSync(outPath, [header, ...dialogues].join('\n'), 'utf8');
  logger.debug({ cues: cues.length, alignmentNumber, outPath }, 'ASS karaoke generated');
  return outPath;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the ASS file header (Script Info + V4+ Styles + Events header row).
 *
 * PlayResX/Y match FFmpeg's internal ASS defaults (384×288) so that
 * CAPTION_FONT_SIZE and CAPTION_MARGIN_V config values scale correctly.
 * ASS scales all sizes by videoHeight/PlayResY at render time.
 */
function buildASSHeader(fontName, fontSize, primaryColour, secondaryColour, outlineColour, alignmentNumber, marginH, marginV) {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 384',
    'PlayResY: 288',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // BackColour &HFF000000 = fully transparent background; BorderStyle=1 = outline only.
    `Style: Default,${fontName},${fontSize},${primaryColour},${secondaryColour},${outlineColour},&HFF000000,0,0,0,0,100,100,0,0,1,2,0,${alignmentNumber},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
}

/** Strip ASS override-block characters that would break the subtitle parser */
function sanitizeAssText(text) {
  return text.replace(/[{}\\]/g, '');
}

/** Format seconds as SRT timestamp: HH:MM:SS,mmm */
function srtTimestamp(totalSeconds) {
  const h  = Math.floor(totalSeconds / 3600);
  const m  = Math.floor((totalSeconds % 3600) / 60);
  const s  = Math.floor(totalSeconds % 60);
  const ms = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Format integer centiseconds as ASS timestamp: H:MM:SS.cc */
function assTimestampFromCs(totalCs) {
  const h  = Math.floor(totalCs / 360000);
  const m  = Math.floor((totalCs % 360000) / 6000);
  const s  = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

module.exports = { generateSRT, generateASS, generateWordByWordASS, VALID_CAPTION_STYLES, validateCaptionStyle };
