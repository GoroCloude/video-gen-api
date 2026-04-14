# video-gen-api

**Input:** image + text  
**Output:** MP4 with TTS voiceover and burned-in captions, stored on MinIO

---

## Stack

| Layer | Tool |
|---|---|
| API | Node.js + Express |
| TTS (primary) | ElevenLabs |
| TTS (fallback) | Google Cloud TTS |
| Video composition | FFmpeg (fluent-ffmpeg) |
| Storage | MinIO (S3-compatible) |

---

## Prerequisites

```bash
# FFmpeg must be installed on the host
sudo apt install ffmpeg        # Debian/Ubuntu
brew install ffmpeg            # macOS
```

---

## Setup

```bash
npm install

# Copy and fill in credentials
cp .env.example .env
```

Required `.env` values:

| Key | Description |
|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs API key (optional — Google TTS used as fallback) |
| `ELEVENLABS_VOICE_ID` | Voice ID (default: Rachel) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to GCP service account JSON |
| `MINIO_ENDPOINT` | MinIO base URL, e.g. `https://minio.shumov.eu` |
| `MINIO_ACCESS_KEY` | MinIO access key |
| `MINIO_SECRET_KEY` | MinIO secret key |
| `MINIO_BUCKET` | Target bucket (must exist) |

---

## Run

```bash
npm start          # production
npm run dev        # nodemon hot-reload
```

---

## API

### `POST /generate`

Multipart form data:

| Field | Type | Required | Description |
|---|---|---|---|
| `image` | file | ✓ | JPEG or PNG (max 20 MB) |
| `text` | string | ✓ | Script — spoken as TTS and shown as captions |

**Success response:**
```json
{
  "success": true,
  "url": "https://minio.shumov.eu/videos/generated/uuid.mp4?X-Amz-...",
  "key": "generated/uuid.mp4",
  "bucket": "videos",
  "duration": 8.42,
  "expiresIn": 3600
}
```

**Error response:**
```json
{ "error": "Description of what went wrong" }
```

### `GET /health`

Returns current config status.

---

## Example cURL

```bash
curl -X POST http://localhost:3000/generate \
  -F "image=@/path/to/photo.jpg" \
  -F "text=Welcome to Munich. This city has over 1.5 million residents and world-class beer gardens."
```

---

## Video settings (`.env`)

| Key | Default | Description |
|---|---|---|
| `VIDEO_WIDTH` | 1080 | Output width in pixels |
| `VIDEO_HEIGHT` | 1920 | Output height (9:16 = Stories/Reels) |
| `CAPTION_FONT_SIZE` | 48 | Subtitle font size |
| `CAPTION_FONT_COLOR` | white | Subtitle text color |
| `CAPTION_OUTLINE_COLOR` | black | Subtitle outline color |

---

## Pipeline

```
POST /generate (image + text)
  │
  ├─ 1. TTS       ElevenLabs → mp3  (fallback: Google TTS)
  ├─ 2. Probe     ffprobe → audio duration
  ├─ 3. Captions  text → .srt (evenly timed)
  ├─ 4. Compose   FFmpeg: image loop + audio + burned-in subs → .mp4
  └─ 5. Upload    MinIO PUT → presigned GET URL
```

All temp files are created in a per-request `os.tmpdir()` directory and cleaned up after upload.
