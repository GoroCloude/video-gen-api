'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('../config');
const logger = require('../logger');

const WORDS_PER_CUE = 8;

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
 * @returns {string} Absolute path to the saved .ass file
 */
function generateASS(text, audioDurationSeconds, outputDir, alignmentNumber) {
  const { fontSize, primaryColour, outlineColour, karaokeColour, marginV, marginH } = config.captions;

  // Strip ASS control characters from user text before embedding in subtitle file.
  const safeText = sanitizeAssText(text);
  const words = safeText.trim().split(/\s+/).filter(Boolean);

  const cues = [];
  for (let i = 0; i < words.length; i += WORDS_PER_CUE) {
    cues.push(words.slice(i, i + WORDS_PER_CUE));
  }

  const totalDurationCs = Math.round(audioDurationSeconds * 100);
  // Floating-point chunk boundaries are rounded to integer cs at each boundary
  // so timestamps and \kf durations stay on the same centisecond grid.
  const chunkDurationRaw = totalDurationCs / cues.length;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    // Use the same PlayRes as FFmpeg's internal ASS default (used by force_style).
    // ASS scales font sizes and margins by videoHeight/PlayResY, so these values
    // must match what force_style used (384x288) to keep CAPTION_FONT_SIZE and
    // CAPTION_MARGIN_V config values visually identical to the old SRT+force_style path.
    'PlayResX: 384',
    'PlayResY: 288',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // SecondaryColour = dim/unspoken word colour (used by \kf karaoke fill).
    // BackColour &HFF000000 = fully transparent background; BorderStyle=1 = outline only.
    `Style: Default,Arial,${fontSize},${primaryColour},${karaokeColour},${outlineColour},&HFF000000,0,0,0,0,100,100,0,0,1,2,0,${alignmentNumber},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

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

module.exports = { generateSRT, generateASS };
