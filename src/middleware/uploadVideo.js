'use strict';

const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');

/**
 * Multer middleware — saves uploaded video to a per-request temp dir.
 * Sets req.tmpDir so the route handler owns cleanup.
 * Accepts any video/* MIME type; size cap via UPLOAD_MAX_VIDEO_SIZE_BYTES.
 */
const uploadVideo = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgen-'));
        req.tmpDir = dir;
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
      cb(null, `video${ext}`);
    },
  }),
  limits: { fileSize: config.upload.maxVideoFileSizeBytes },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('video/')) return cb(null, true);
    const err = new Error('Only video files are accepted');
    err.status = 415;
    cb(err);
  },
});

module.exports = uploadVideo;
