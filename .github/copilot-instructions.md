# Copilot Instructions

## Commands

```bash
npm install        # install dependencies
npm start          # production: node src/server.js
npm run dev        # dev: nodemon src/server.js (hot-reload)
```

No automated test suite. Verify manually:
```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/generate \
  -F "image=@/path/to/photo.jpg" \
  -F "text=Your script text here."
```

**Prerequisite:** FFmpeg and ffprobe must be installed and on `PATH`.

## Architecture

Three-endpoint Express API. All processing is synchronous per-request — no job queue, no workers.

| Endpoint | Input | What it does |
|---|---|---|
| `POST /generate` | image + text | Still image → TTS audio + captions → `.mp4` |
| `POST /generate-video` | video + text | Existing video → replaces audio with TTS + burns captions |
| `POST /combine` | array of MP4 URLs | Downloads and concatenates videos (with optional xfade transitions) |

**Module layout:**
- `src/server.js` — entry point; loads `.env` before all other `require`s, validates config, starts Express
- `src/app.js` — Express wiring: helmet, per-request UUID + child logger, rate limiter, routes, global error handler
- `src/config.js` — single frozen config object; throws at `require`-time for missing required vars
- `src/services/tts.js` — ElevenLabs (primary) → Google TTS (fallback); Google client is a singleton
- `src/services/captions.js` — splits text into 8-word chunks, distributes evenly → `.srt`
- `src/services/composer.js` — ffprobe + FFmpeg encoding; exports `VALID_EFFECTS`
- `src/services/storage.js` — AWS SDK v3 upload to MinIO; returns permanent public URL
- `src/openapi.js` — OpenAPI spec; served at `GET /api-docs` (Swagger UI) and `GET /api-docs/json`

**`POST /generate` pipeline:**
1. Multer saves image to a per-request `os.tmpdir()/vgen-*` dir → `req.tmpDir`
2. TTS → `.mp3`
3. ffprobe → audio duration
4. Captions → `.srt`
5. FFmpeg → `.mp4`
6. MinIO upload → presigned URL
7. `finally` block: `fs.rmSync(tmpDir, { recursive: true })`

## Key Conventions

### Config
- **Always read from `config.js`**, never from `process.env` directly in service modules.
- `required('VAR')` throws at startup if missing. `optional('VAR', default)` provides fallbacks.
- Required vars: `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`.

### Logging
- Use `pino` — **never `console.log`** in service modules.
- Each request gets a child logger via `req.log = logger.child({ reqId, method, url })`.
- Log levels: `info` for pipeline steps, `debug` for FFmpeg commands/paths, `warn` for fallbacks (e.g., ElevenLabs → Google TTS), `error` for failures.

### FFmpeg filter chain
- **Never split `-vf` and `complexFilter`** — they cannot coexist in the same FFmpeg invocation.
- The single `-vf` chain is always: `scale+pad → [zoompan if motion] → subtitles`.
- `combine.js` uses `spawn('ffmpeg', args)` directly (not fluent-ffmpeg) to build `filter_complex` for xfade/acrossfade.

### Motion effects (overscan pattern)
- Before applying any motion effect, pre-scale the image to `OVERSCAN` (1.3×) the output dimensions (e.g. 1404×2496 for 1080×1920 output).
- FFmpeg's `zoompan` then animates within that buffer. At `z=1.0` the full overscan area is visible; at `z=1.3` the original crop is restored.
- **Never add a motion effect without this pre-scale** — the output will upscale and pixelate.
- `VALID_EFFECTS` exported from `services/composer.js` is the **single source of truth** for effect names — used by route validation and `openapi.js`. Do not duplicate the list.

### Caption colours
- Use **ASS hex format** `&H00BBGGRR` (byte-reversed from CSS RGB), not CSS colour strings.
- `CAPTION_PRIMARY_COLOUR` / `CAPTION_OUTLINE_COLOUR` env vars expect this format.
- Caption position uses **ASS numpad alignment** (1–9). `POSITION_MAP` in `composer.js` maps human-readable strings to alignment numbers.

### Windows FFmpeg subtitle path
- `escapePath()` in `composer.js` must produce `'C\:/path/file.srt'` — single-quoted **and** colon escaped as `\:`.
- Both the quotes and the `\:` are required; either alone fails on Windows.

### Storage (MinIO)
- S3 client uses `forcePathStyle: true` — required for MinIO, not for AWS S3.
- `MINIO_PUBLIC_URL` can differ from `MINIO_ENDPOINT` (internal upload URL vs public-facing URL). Defaults to `MINIO_ENDPOINT` if not set.
- `uploadToStorage` returns a permanent public URL, not a presigned URL.

### Per-request temp dirs
- Always clean up in a `finally` block: `fs.rmSync(tmpDir, { recursive: true, force: true })`.
- The global error handler in `app.js` also cleans `req.tmpDir` if an error occurs before the route handler.

### Identifiers
- Use `crypto.randomUUID()` (built-in, Node ≥ 14.17) — the `uuid` package is not used.

### Rate limiting
- Applied to all three POST endpoints (`/generate`, `/generate-video`, `/combine`).
- Configured via `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`.
