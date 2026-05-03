'use strict';

const { VALID_EFFECTS, VALID_CAPTION_POSITIONS, VALID_FONTS } = require('./services/composer');
const { VALID_TRANSITIONS } = require('./routes/combine');
const { VALID_CAPTION_STYLES } = require('./services/captions');

/**
 * OpenAPI 3.0.3 specification for video-gen-api.
 * Served as interactive docs at GET /api-docs.
 */
const spec = {
  openapi: '3.0.3',
  info: {
    title: 'video-gen-api',
    version: '2.4.0',
    description:
      'Generates MP4 videos from an image or video clip, a text script, and TTS audio.\n\n' +
      '**Endpoints**\n\n' +
      '- `POST /generate` — still image + script → looping image video with TTS + captions\n' +
      '- `POST /generate-video` — video clip + script → video with TTS audio + captions overlay\n' +
      '- `POST /combine` — list of MP4 URLs → concatenated MP4 (stream copy, no re-encode)\n\n' +
      '**Pipeline** (generate and generate-video)\n\n' +
      'ElevenLabs TTS (Google TTS fallback) → ffprobe duration → ' +
      'SRT captions → FFmpeg compose → MinIO upload → permanent public URL\n\n' +
      '**Motion effects** — `effect` field (per-request) or `VIDEO_EFFECT` env var (server default):\n\n' +
      '| Value | Motion |\n|---|---|\n' +
      '| `none` | Static image |\n' +
      '| `zoom-in` | Slowly zooms in |\n' +
      '| `zoom-out` | Starts zoomed in, pulls back |\n' +
      '| `pan-right` | Pans left → right |\n' +
      '| `pan-left` | Pans right → left |\n' +
      '| `ken-burns` | Zoom-in with diagonal drift |\n' +
      '| `shake` | Subtle handheld-camera shake |\n\n' +
      '**Caption style** — configured via env vars: `CAPTION_FONT_SIZE`, `CAPTION_PRIMARY_COLOUR`, ' +
      '`CAPTION_OUTLINE_COLOUR`, `CAPTION_POSITION` (`bottom-center` default), ' +
      '`CAPTION_MARGIN_V`, `CAPTION_MARGIN_H`.',
    contact: { url: 'https://github.com/your-org/video-gen-api' },
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local development' },
  ],
  paths: {
    '/generate': {
      post: {
        summary: 'Generate a video',
        description:
          'Synchronous pipeline — the response is returned only after the MP4 is uploaded to MinIO.\n\n' +
          'Expect **10–60 s** depending on text length, TTS provider latency, and server load.\n\n' +
          'The `effect` field overrides the server-level `VIDEO_EFFECT` env var for this single request.',
        operationId: 'generateVideo',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['image', 'text'],
                properties: {
                  image: {
                    type: 'string',
                    format: 'binary',
                    description:
                      'JPEG or PNG source image.\n\n' +
                      'Max size: 20 MB by default (configurable via `UPLOAD_MAX_FILE_SIZE_BYTES`).',
                  },
                  text: {
                    type: 'string',
                    minLength: 1,
                    description:
                      'Script text — spoken as TTS and burned in as captions.\n\n' +
                      'Captions are split into 8-word cues distributed evenly over the audio duration.',
                    example: 'Welcome to Munich. This city has over 1.5 million residents and world-class beer gardens.',
                  },
                  effect: {
                    type: 'string',
                    enum: VALID_EFFECTS,
                    default: 'none',
                    description:
                      'Motion effect applied to the still image during encoding.\n\n' +
                      '| Value | Motion |\n|---|---|\n' +
                      '| `none` | Static image (default) |\n' +
                      '| `zoom-in` | Slowly zooms in over the video duration |\n' +
                      '| `zoom-out` | Starts zoomed in, slowly pulls back |\n' +
                      '| `pan-right` | Pans left → right |\n' +
                      '| `pan-left` | Pans right → left |\n' +
                      '| `ken-burns` | Zoom-in with a diagonal drift |\n' +
                      '| `shake` | Subtle handheld-camera shake |\n\n' +
                      'Omit to use the server-level `VIDEO_EFFECT` env var (default: `none`).',
                    example: 'ken-burns',
                  },
                  captionPosition: {
                    type: 'string',
                    enum: VALID_CAPTION_POSITIONS,
                    description:
                      'Vertical position of the burned-in captions.\n\n' +
                      '| Value | Position |\n|---|---|\n' +
                      '| `top` | Top-center |\n' +
                      '| `center` | Middle-center |\n' +
                      '| `bottom` | Bottom-center (default) |\n\n' +
                      'Omit to use the server-level `CAPTION_POSITION` env var.',
                    example: 'top',
                  },
                  captionStyle: {
                    type: 'string',
                    enum: VALID_CAPTION_STYLES,
                    default: 'word-by-word',
                    description:
                      'Caption rendering style.\n\n' +
                      '| Value | Effect |\n|---|---|\n' +
                      '| `word-by-word` | One word on screen at a time — TikTok/Reels style (default) |\n' +
                      '| `karaoke` | 8-word chunks visible simultaneously; each word fills from dim to bright as audio progresses |\n\n' +
                      'Omit to use the server-level `CAPTION_STYLE` env var (default: `word-by-word`).',
                    example: 'word-by-word',
                  },
                  fontSize: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 200,
                    description:
                      'Caption font size (ASS units, scaled by video height / 288).\n\n' +
                      'On a 1920 px tall video, size 7 ≈ 47 px. ' +
                      'Omit to use the server-level `CAPTION_FONT_SIZE` env var (default: 7).',
                    example: 7,
                  },
                  fontName: {
                    type: 'string',
                    enum: VALID_FONTS,
                    default: 'Arial',
                    description:
                      'Caption font family name.\n\n' +
                      'Omit to use the server-level `CAPTION_FONT_NAME` env var (default: `Arial`).',
                    example: 'Impact',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Video generated and uploaded successfully.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/GenerateSuccess' },
                example: {
                  success: true,
                  url: 'https://minio.shumov.eu/videos/generated/550e8400-e29b-41d4-a716-446655440000.mp4',
                  key: 'generated/550e8400-e29b-41d4-a716-446655440000.mp4',
                  bucket: 'videos',
                  duration: 8.42,
                },
              },
            },
          },
          400: {
            description: 'Validation error — missing required field or invalid field value.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                examples: {
                  missingImage: { summary: 'No image uploaded',        value: { error: 'Missing field: image' } },
                  missingText:  { summary: 'No text provided',         value: { error: 'Missing field: text'  } },
                  badEffect:    { summary: 'Unknown effect value',      value: { error: `Invalid effect "fly". Valid values: ${VALID_EFFECTS.join(', ')}` } },
                },
              },
            },
          },
          413: {
            description: 'Image exceeds the configured size limit.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: 'Image too large (max 20 MB)' },
              },
            },
          },
          415: {
            description: 'Uploaded file is not an image.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: 'Only image files are accepted' },
              },
            },
          },
          429: {
            description: 'Rate limit exceeded (default: 10 requests / 60 s per IP).',
            headers: {
              'RateLimit-Limit':     { schema: { type: 'integer' }, description: 'Maximum requests allowed in the window' },
              'RateLimit-Remaining': { schema: { type: 'integer' }, description: 'Requests remaining in the current window' },
              'RateLimit-Reset':     { schema: { type: 'integer' }, description: 'Seconds until the window resets' },
            },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: 'Too many requests — please try again later' },
              },
            },
          },
          500: {
            description: 'Internal error — TTS failure, FFmpeg error, or MinIO upload failure.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: 'ffmpeg exited with code 1' },
              },
            },
          },
        },
      },
    },

    '/generate-video': {
      post: {
        summary: 'Generate a video from a video clip',
        description:
          'Accepts an existing video and a text script. Replaces the video\'s audio with TTS ' +
          'generated from `text`, burns in captions, and scales/pads the output to the configured ' +
          'dimensions (`VIDEO_WIDTH` × `VIDEO_HEIGHT`).\n\n' +
          'The output stops at whichever ends first — the source video or the TTS audio (`-shortest`).\n\n' +
          'Synchronous — the response is returned only after the MP4 is uploaded to MinIO.\n\n' +
          'Expect **15–90 s** depending on clip length, TTS latency, and server load.',
        operationId: 'generateFromVideo',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['video', 'text'],
                properties: {
                  video: {
                    type: 'string',
                    format: 'binary',
                    description:
                      'Source video file (MP4, MOV, WebM, etc.).\n\n' +
                      'Max size: 500 MB by default (configurable via `UPLOAD_MAX_VIDEO_SIZE_BYTES`).',
                  },
                  text: {
                    type: 'string',
                    minLength: 1,
                    description:
                      'Voiceover script — spoken as TTS and burned in as captions.',
                    example: 'The historic city centre dates back over 800 years and draws millions of visitors each year.',
                  },
                  effect: {
                    type: 'string',
                    enum: VALID_EFFECTS,
                    default: 'none',
                    description:
                      'Motion effect applied during encoding. Omit to use the server-level `VIDEO_EFFECT` env var.',
                    example: 'none',
                  },
                  captionPosition: {
                    type: 'string',
                    enum: VALID_CAPTION_POSITIONS,
                    description:
                      'Vertical position of the burned-in captions: `top`, `center`, or `bottom` (default).\n\n' +
                      'Omit to use the server-level `CAPTION_POSITION` env var.',
                    example: 'bottom',
                  },
                  captionStyle: {
                    type: 'string',
                    enum: VALID_CAPTION_STYLES,
                    default: 'word-by-word',
                    description:
                      'Caption rendering style.\n\n' +
                      '| Value | Effect |\n|---|---|\n' +
                      '| `word-by-word` | One word on screen at a time (default) |\n' +
                      '| `karaoke` | 8-word chunks; words fill from dim to bright as audio progresses |\n\n' +
                      'Omit to use the server-level `CAPTION_STYLE` env var.',
                    example: 'word-by-word',
                  },
                  fontSize: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 200,
                    description:
                      'Caption font size (ASS units, scaled by video height / 288).\n\n' +
                      'On a 1920 px tall video, size 7 ≈ 47 px. ' +
                      'Omit to use the server-level `CAPTION_FONT_SIZE` env var (default: 7).',
                    example: 7,
                  },
                  fontName: {
                    type: 'string',
                    enum: VALID_FONTS,
                    default: 'Arial',
                    description:
                      'Caption font family name.\n\n' +
                      'Omit to use the server-level `CAPTION_FONT_NAME` env var (default: `Arial`).',
                    example: 'Impact',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Video composed and uploaded successfully.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/GenerateSuccess' },
                example: {
                  success: true,
                  url: 'https://minio.shumov.eu/videos/generated/550e8400-e29b-41d4-a716-446655440001.mp4',
                  key: 'generated/550e8400-e29b-41d4-a716-446655440001.mp4',
                  bucket: 'videos',
                  duration: 12.15,
                },
              },
            },
          },
          400: {
            description: 'Validation error — missing required field.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                examples: {
                  missingVideo: { summary: 'No video uploaded', value: { error: 'Missing field: video' } },
                  missingText:  { summary: 'No text provided',  value: { error: 'Missing field: text'  } },
                  badEffect:    { summary: 'Unknown effect',     value: { error: `Invalid effect "fly". Valid values: ${VALID_EFFECTS.join(', ')}` } },
                },
              },
            },
          },
          413: {
            description: 'Video exceeds the configured size limit.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: 'File too large' },
              },
            },
          },
          415: {
            description: 'Uploaded file is not a video.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: 'Only video files are accepted' },
              },
            },
          },
          429: {
            description: 'Rate limit exceeded (default: 10 requests / 60 s per IP).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: 'Too many requests — please try again later' },
              },
            },
          },
          500: {
            description: 'Internal error — TTS failure, FFmpeg error, or MinIO upload failure.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: 'ffmpeg exited with code 1' },
              },
            },
          },
        },
      },
    },

    '/combine': {
      post: {
        summary: 'Combine videos',
        description:
          'Downloads the supplied MP4 URLs and concatenates them in order into a single MP4.\n\n' +
          'Uses FFmpeg stream copy (no re-encoding) — fast and lossless, but requires all inputs ' +
          'to have compatible codecs and resolution. All videos produced by `POST /generate` qualify.\n\n' +
          'The resulting video is uploaded to MinIO and a presigned URL is returned.',
        operationId: 'combineVideos',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CombineRequest' },
              example: {
                urls: [
                  'https://minio-api.shumov.eu/videos/generated/uuid-1.mp4',
                  'https://minio-api.shumov.eu/videos/generated/uuid-2.mp4',
                  'https://minio-api.shumov.eu/videos/generated/uuid-3.mp4',
                ],
                transition: 'fade',
                transitionDuration: 0.5,
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Videos combined and uploaded successfully.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CombineSuccess' },
                example: {
                  success:            true,
                  url:                'https://minio-api.shumov.eu/videos/combined/550e8400-e29b-41d4-a716-446655440000.mp4',
                  key:                'combined/550e8400-e29b-41d4-a716-446655440000.mp4',
                  bucket:             'videos',
                  duration:           26.84,
                  videoCount:         3,
                  transition:         'fade',
                  transitionDuration: 0.5,
                },
              },
            },
          },
          400: {
            description: 'Validation error — missing or invalid `urls` array.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                examples: {
                  missingUrls:     { summary: 'No urls provided',         value: { error: 'Missing field: urls (must be a non-empty array)' } },
                  tooFewUrls:      { summary: 'Only one URL given',       value: { error: 'At least 2 URLs are required to combine' } },
                  tooManyUrls:     { summary: 'Over 20 URLs given',       value: { error: 'Too many URLs — maximum is 20' } },
                  badUrl:          { summary: 'Invalid URL',              value: { error: 'urls[1] is not a valid URL' } },
                  badTransition:   { summary: 'Unknown transition',       value: { error: `Invalid transition "fly". Valid values: ${VALID_TRANSITIONS.join(', ')}` } },
                  badTDuration:    { summary: 'transitionDuration out of range', value: { error: 'transitionDuration must be between 0 and 3 seconds' } },
                  downloadFail:    { summary: 'Download failed',          value: { error: 'Failed to download video (https://…): HTTP 403' } },
                },
              },
            },
          },
          429: {
            description: 'Rate limit exceeded.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: 'Too many requests — please try again later' },
              },
            },
          },
          500: {
            description: 'Internal error — download failure, FFmpeg error, or MinIO upload failure.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
                example: { error: 'ffmpeg exited with code 1' },
              },
            },
          },
        },
      },
    },

    '/health': {
      get: {
        summary: 'Health check',
        description:
          'Returns the active runtime configuration.\n\n' +
          'Does **not** ping MinIO or TTS providers — safe to poll frequently.',
        operationId: 'healthCheck',
        responses: {
          200: {
            description: 'Service is running.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
                example: {
                  status: 'ok',
                  tts: 'elevenlabs+google-fallback',
                  video: '1080x1920',
                },
              },
            },
          },
        },
      },
    },
  },

  components: {
    schemas: {
      CombineRequest: {
        type: 'object',
        required: ['urls'],
        properties: {
          urls: {
            type: 'array',
            minItems: 2,
            maxItems: 20,
            items: { type: 'string', format: 'uri' },
            description: 'Ordered list of MP4 URLs to concatenate (2–20). Without a transition all inputs must share the same codec and resolution.',
            example: [
              'https://minio-api.shumov.eu/videos/generated/uuid-1.mp4',
              'https://minio-api.shumov.eu/videos/generated/uuid-2.mp4',
            ],
          },
          transition: {
            type: 'string',
            enum: VALID_TRANSITIONS,
            default: 'none',
            description:
              'xfade transition applied between every pair of clips.\n\n' +
              '`none` (default) uses stream copy (fast, lossless). Any other value triggers a full ' +
              're-encode with the selected xfade video transition and an acrossfade audio cross-fade.\n\n' +
              '| Value | Motion |\n|---|---|\n' +
              '| `none` | Cut (no transition) |\n' +
              '| `fade` | Smooth opacity fade |\n' +
              '| `fadeblack` | Fade through black |\n' +
              '| `fadewhite` | Fade through white |\n' +
              '| `dissolve` | Cross-dissolve |\n' +
              '| `wipeleft/right/up/down` | Hard wipe in that direction |\n' +
              '| `slideleft/right/up/down` | Outgoing clip slides out |\n' +
              '| `circlecrop` | Circle crop reveal |\n' +
              '| `circleopen/close` | Iris open / close |',
            example: 'fade',
          },
          transitionDuration: {
            type: 'number',
            format: 'float',
            default: 0.5,
            minimum: 0,
            maximum: 3,
            description: 'Duration of each transition in seconds (0–3). Ignored when `transition` is `"none"`.',
            example: 0.5,
          },
        },
      },

      CombineSuccess: {
        type: 'object',
        required: ['success', 'url', 'key', 'bucket', 'duration', 'videoCount'],
        properties: {
          success:            { type: 'boolean', example: true },
          url:                { type: 'string', format: 'uri', description: 'Permanent public URL of the combined MP4 on MinIO.' },
          key:                { type: 'string', example: 'combined/550e8400-e29b-41d4-a716-446655440000.mp4', description: 'Object key in the MinIO bucket.' },
          bucket:             { type: 'string', example: 'videos', description: 'MinIO bucket name.' },
          duration:           { type: 'number', format: 'float', description: 'Total combined video duration in seconds.', example: 26.84 },
          videoCount:         { type: 'integer', description: 'Number of input videos that were combined.', example: 3 },
          transition:         { type: 'string', description: 'Transition used (omitted when `none`).', example: 'fade' },
          transitionDuration: { type: 'number', format: 'float', description: 'Transition duration in seconds (omitted when no transition).', example: 0.5 },
        },
      },

      GenerateSuccess: {
        type: 'object',
        required: ['success', 'url', 'key', 'bucket', 'duration'],
        properties: {
          success:  { type: 'boolean', example: true },
          url:      { type: 'string', format: 'uri', description: 'Permanent public URL of the generated MP4 on MinIO.' },
          key:      { type: 'string', example: 'generated/550e8400-e29b-41d4-a716-446655440000.mp4', description: 'Object key in the MinIO bucket.' },
          bucket:   { type: 'string', example: 'videos', description: 'MinIO bucket name.' },
          duration: { type: 'number', format: 'float', description: 'TTS audio duration in seconds.', example: 8.42 },
        },
      },

      HealthResponse: {
        type: 'object',
        required: ['status', 'tts', 'video'],
        properties: {
          status: { type: 'string', enum: ['ok'] },
          tts: {
            type: 'string',
            enum: ['elevenlabs+google-fallback', 'google'],
            description: 'Active TTS provider. `elevenlabs+google-fallback` means ElevenLabs is primary with automatic Google TTS fallback.',
          },
          video: { type: 'string', example: '1080x1920', description: 'Output video dimensions (width×height px).' },
        },
      },

      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string', description: 'Human-readable description of what went wrong.' },
        },
      },
    },
  },
};

module.exports = spec;
