'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
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

/** Format seconds as SRT timestamp: HH:MM:SS,mmm */
function srtTimestamp(totalSeconds) {
  const h  = Math.floor(totalSeconds / 3600);
  const m  = Math.floor((totalSeconds % 3600) / 60);
  const s  = Math.floor(totalSeconds % 60);
  const ms = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

module.exports = { generateSRT };
