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
 * Build an ASS subtitle file with all style properties baked in.
 * Using ASS (instead of SRT + force_style) is required for reliable
 * caption positioning — libass ignores force_style Alignment for SRT inputs.
 *
 * @param {string} text
 * @param {number} audioDurationSeconds
 * @param {string} outputDir
 * @param {number} alignmentNumber  ASS numpad alignment (1–9)
 * @returns {string} Absolute path to the saved .ass file
 */
function generateASS(text, audioDurationSeconds, outputDir, alignmentNumber) {
  const { fontSize, primaryColour, outlineColour, marginV, marginH } = config.captions;

  const words = text.trim().split(/\s+/);
  const cues = [];
  for (let i = 0; i < words.length; i += WORDS_PER_CUE) {
    cues.push(words.slice(i, i + WORDS_PER_CUE).join(' '));
  }

  const cueDuration = audioDurationSeconds / cues.length;

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
    // BackColour &HFF000000 = fully transparent background; BorderStyle=1 = outline only
    `Style: Default,Arial,${fontSize},${primaryColour},&H000000FF,${outlineColour},&HFF000000,0,0,0,0,100,100,0,0,1,2,0,${alignmentNumber},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const dialogues = cues.map((cue, idx) => {
    const startSec = idx * cueDuration;
    const endSec   = Math.min((idx + 1) * cueDuration, audioDurationSeconds);
    return `Dialogue: 0,${assTimestamp(startSec)},${assTimestamp(endSec)},Default,,0,0,0,,${cue}`;
  });

  const outPath = path.join(outputDir, `${randomUUID()}.ass`);
  fs.writeFileSync(outPath, [header, ...dialogues].join('\n'), 'utf8');
  logger.debug({ cues: cues.length, alignmentNumber, outPath }, 'ASS generated');
  return outPath;
}

/** Format seconds as SRT timestamp: HH:MM:SS,mmm */
function srtTimestamp(totalSeconds) {
  const h  = Math.floor(totalSeconds / 3600);
  const m  = Math.floor((totalSeconds % 3600) / 60);
  const s  = Math.floor(totalSeconds % 60);
  const ms = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Format seconds as ASS timestamp: H:MM:SS.cc (centiseconds) */
function assTimestamp(totalSeconds) {
  const h  = Math.floor(totalSeconds / 3600);
  const m  = Math.floor((totalSeconds % 3600) / 60);
  const s  = Math.floor(totalSeconds % 60);
  const cs = Math.round((totalSeconds - Math.floor(totalSeconds)) * 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

module.exports = { generateSRT, generateASS };
