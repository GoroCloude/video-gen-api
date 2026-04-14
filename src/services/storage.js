'use strict';

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const config = require('../config');
const logger = require('../logger');

// Singleton — reused across requests
const s3 = new S3Client({
  endpoint:    config.minio.endpoint,
  region:      config.minio.region,
  credentials: {
    accessKeyId:     config.minio.accessKey,
    secretAccessKey: config.minio.secretKey,
  },
  forcePathStyle: true,   // required for MinIO; AWS S3 uses virtual-hosted style
});

const BUCKET    = config.minio.bucket;
const publicBase = (config.minio.publicUrl || config.minio.endpoint).replace(/\/$/, '');

/**
 * Upload an MP4 file to MinIO and return a permanent public URL.
 * The bucket must have a public read policy for the URL to be accessible.
 * @param {string} filePath  Local path to the .mp4 file
 * @param {string} key       Object key, e.g. "generated/uuid.mp4"
 * @returns {Promise<{ url: string, key: string, bucket: string }>}
 */
async function uploadToStorage(filePath, key) {
  logger.debug({ key, bucket: BUCKET }, 'MinIO: uploading');

  const stat = await fs.promises.stat(filePath);

  const body = fs.createReadStream(filePath);
  body.on('error', (err) => {
    logger.error({ err: err.message }, 'MinIO: read stream error');
  });

  await s3.send(new PutObjectCommand({
    Bucket:        BUCKET,
    Key:           key,
    Body:          body,
    ContentType:   'video/mp4',
    ContentLength: stat.size,
  }));

  const url = `${publicBase}/${BUCKET}/${key}`;
  logger.debug({ key, url }, 'MinIO: upload complete');
  return { url, key, bucket: BUCKET };
}

module.exports = { uploadToStorage };
