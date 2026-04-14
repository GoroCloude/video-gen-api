# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dependencies (includes pino, helmet, express-rate-limit)
npm start          # production: node src/server.js
npm run dev        # dev: nodemon src/server.js (hot-reload)
```

Test the API manually:
```bash
curl -X POST http://localhost:3000/generate \
  -F "image=@/path/to/photo.jpg" \
  -F "text=Your script text here."

curl http://localhost:3000/health
```

## Architecture

Single-endpoint Express API. All logic runs synchronously per-request — no job queue, no workers.

**`src/server.js`** — HTTP server entry point. Loads `.env` first (before any other require), then validates config, starts Express, registers SIGTERM/SIGINT handlers, and catches unhandled rejections.

**`src/app.js`** — Express app wiring: helmet security headers, per-request UUID + child logger, rate limiter (POST /generate only), routes, 404, and global error handler. The error handler also cleans up any `req.tmpDir` left by multer if an error occurs before the route handler runs.

**`src/config.js`** — Single frozen config object built from env vars. `required()` throws at require-time for missing vars (fail fast at startup). All service modules consume `config` rather than reading `process.env` directly.

**Request pipeline** (`POST /generate`):
1. Multer saves the uploaded image to a per-request `os.tmpdir()/vgen-*` dir → sets `req.tmpDir`
2. **`services/tts.js`** — ElevenLabs (primary) → Google TTS (fallback); Google client is a singleton
3. **`services/composer.js`** — ffprobe measures audio duration
4. **`services/captions.js`** — splits text into 8-word chunks, distributes evenly → `.srt` file
5. **`services/composer.js`** — FFmpeg encodes still-image loop + audio + burned-in subtitles → `.mp4`
6. **`services/storage.js`** — uploads `.mp4` via AWS SDK v3 (`forcePathStyle: true`), returns presigned GET URL
7. `finally` block in the route handler calls `fs.rmSync(tmpDir, { recursive: true })` on both success and error paths

## Motion effects

`VIDEO_EFFECT` env var sets the server default; `effect` form field overrides it per-request. Valid values: `none`, `zoom-in`, `zoom-out`, `pan-left`, `pan-right`, `ken-burns`, `shake`.

The **overscan pattern** in `composer.js`: motion effects pre-scale the source image to 1.3× output dimensions (e.g. 1404×2496 for 1080×1920). FFmpeg's `zoompan` then crops/animates within that buffer. At z=1.0 the full 1.3× area shows; at z=1.3 the original framing is restored. Never add motion effects without this pre-scale or the output will upscale/pixelate.

`VALID_EFFECTS` is exported from `services/composer.js` — it is the single source of truth used by the route handler (400 validation) and `openapi.js` (enum values). Do not duplicate the list elsewhere.

## Caption configuration

Caption position uses ASS numpad alignment (1–9). The `POSITION_MAP` in `composer.js` maps human-readable strings (`bottom-center`, `top-left`, etc.) to ASS alignment numbers. Subtitle colours use ASS hex format `&H00BBGGRR` (not CSS/RGB). Controlled via:
- `CAPTION_POSITION` (default: `bottom-center`)
- `CAPTION_FONT_SIZE`, `CAPTION_PRIMARY_COLOUR`, `CAPTION_OUTLINE_COLOUR`
- `CAPTION_MARGIN_V`, `CAPTION_MARGIN_H`

## Key design decisions

- **Config validated at startup**: if `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, or `MINIO_SECRET_KEY` are missing, the process exits before accepting any requests.
- **Single `-vf` filter chain in FFmpeg**: `scale+pad → [zoompan] → subtitles`. `complexFilter` and `-vf` cannot be used simultaneously — do not split them.
- **`pino`** for structured JSON logging in production; pretty-printed in development. Each request gets a child logger with its UUID (`reqId`). Do not use `console.log` in service modules.
- **Rate limiting** is applied only to `POST /generate` (CPU/API-intensive). Configured via `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`.
- **`uuid` package removed** — `crypto.randomUUID()` is used throughout (built-in Node.js ≥ 14.17).
- **OpenAPI docs** served at `GET /api-docs` (Swagger UI) and `GET /api-docs/json` (raw spec). Spec lives in `src/openapi.js`.

## Windows FFmpeg subtitle path

`escapePath()` in `services/composer.js` must produce `'C\:/path/file.srt'` — single-quoted with backslash-escaped colon. Both the quotes AND the `\:` are required; either alone fails on Windows. This is the only form that works with FFmpeg's `subtitles=` filter parser on Windows.

## Environment

All configuration via `.env` (see `.env.example`). Required vars: `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`. All others have defaults. `GOOGLE_APPLICATION_CREDENTIALS` is consumed implicitly by the Google TTS SDK (Application Default Credentials).

## FFmpeg prerequisite

FFmpeg and ffprobe must be installed and on `PATH`. The `escapePath()` function in `services/composer.js` converts backslashes to forward slashes and escapes colons — required for the `subtitles=` filter on Windows paths.
