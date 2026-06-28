import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  videoProcessingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
  videoProcessingBackoffMs: parseInt(
    process.env.VIDEO_PROCESSING_BACKOFF_MS || '5000',
    10,
  ),
}));
