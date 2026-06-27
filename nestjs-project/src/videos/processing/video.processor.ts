import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { StorageService } from '../../storage/storage.service';
import { VideoStatus } from '../entities/video.entity';
import { VideosService } from '../videos.service';
import { FfmpegService } from './ffmpeg.service';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videosService.findById(videoId);
    if (
      !video ||
      video.status !== VideoStatus.PROCESSING ||
      !video.storage_key
    ) {
      this.logger.warn(
        `Skipping job for video ${videoId} — not in a processable state`,
      );
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), 'streamtube-'));
    const inputPath = join(workDir, 'original');
    const thumbPath = join(workDir, 'thumb.jpg');

    try {
      await this.storageService.downloadToFile(video.storage_key, inputPath);
      const probe = await this.ffmpegService.probe(inputPath);
      const offset = Math.min(1, Math.max(0, probe.durationSeconds / 2));
      await this.ffmpegService.generateThumbnail(inputPath, thumbPath, offset);

      const thumbnailBuffer = await readFile(thumbPath);
      const thumbnailKey = this.storageService.buildThumbnailKey(videoId);
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      await this.videosService.markReady(videoId, {
        durationSeconds: probe.durationSeconds,
        metadata: {
          width: probe.width,
          height: probe.height,
          codec: probe.codec,
          bitrate: probe.bitrate,
          format: probe.format,
        },
        thumbnailKey,
      });
      this.logger.log(`Video ${videoId} processed successfully`);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= attempts) {
      await this.videosService.markError(
        job.data.videoId,
        job.failedReason ?? 'Video processing failed',
      );
      this.logger.error(
        `Video ${job.data.videoId} failed after ${job.attemptsMade} attempts: ${job.failedReason}`,
      );
    }
  }
}
