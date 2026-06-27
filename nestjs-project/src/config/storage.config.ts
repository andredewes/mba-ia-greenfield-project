import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
  bucket: process.env.S3_BUCKET || 'streamtube-videos',
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  uploadPartSizeBytes: parseInt(
    process.env.UPLOAD_PART_SIZE_BYTES || '104857600',
    10,
  ),
  uploadPresignExpirySeconds: parseInt(
    process.env.UPLOAD_PRESIGN_EXPIRY_SECONDS || '21600',
    10,
  ),
  downloadPresignExpirySeconds: parseInt(
    process.env.DOWNLOAD_PRESIGN_EXPIRY_SECONDS || '3600',
    10,
  ),
}));
