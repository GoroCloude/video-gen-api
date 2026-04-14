'use strict';

const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');

/**
 * Multer middleware — saves image to a per-request temp dir.
 * Sets req.tmpDir so the route handler owns cleanup.
 *
 * Temp dir is created in destination(), which runs before fileFilter.
 * The error middleware in app.js handles cleanup if multer itself rejects.
 */
const upload = multer({
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
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `image${ext}`);
    },
  }),
  limits: { fileSize: config.upload.maxFileSizeBytes },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    const err = new Error('Only image files are accepted');
    err.status = 415;
    cb(err);
  },
});

module.exports = upload;
