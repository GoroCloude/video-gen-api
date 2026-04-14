'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const config = require('../config');
const logger = require('../logger');

// Singleton — reused across requests, authenticates once
const googleClient = new TextToSpeechClient();

/**
 * Generate speech from text.
 * Tries ElevenLabs first if an API key is configured; falls back to Google TTS.
 * @returns {Promise<string>} Absolute path to the saved .mp3 file
 */
async function generateTTS(text, outputDir) {
  const outPath = path.join(outputDir, `${randomUUID()}.mp3`);

  if (config.elevenlabs.apiKey) {
    try {
      logger.debug('TTS: trying ElevenLabs');
      await elevenLabsTTS(text, outPath);
      logger.debug({ outPath }, 'TTS: ElevenLabs succeeded');
      return outPath;
    } catch (err) {
      // Log without exposing the API key value
      logger.warn({ statusCode: err.response?.status, message: err.message },
        'TTS: ElevenLabs failed, falling back to Google TTS');
    }
  }

  logger.debug('TTS: using Google TTS');
  await googleTTS(text, outPath);
  logger.debug({ outPath }, 'TTS: Google TTS succeeded');
  return outPath;
}

async function elevenLabsTTS(text, outPath) {
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabs.voiceId}`,
    {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    {
      headers: {
        'xi-api-key': config.elevenlabs.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      responseType: 'arraybuffer',
      timeout: config.elevenlabs.timeoutMs,
    }
  );

  if (!response.data || response.data.byteLength === 0) {
    throw new Error('ElevenLabs returned an empty audio response');
  }

  fs.writeFileSync(outPath, Buffer.from(response.data));
}

async function googleTTS(text, outPath) {
  const [response] = await googleClient.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: config.google.languageCode,
      name: config.google.voiceName,
    },
    audioConfig: { audioEncoding: 'MP3' },
  });

  if (!response.audioContent || response.audioContent.length === 0) {
    throw new Error('Google TTS returned empty audio content');
  }

  fs.writeFileSync(outPath, Buffer.from(response.audioContent));
}

module.exports = { generateTTS };
