jest.mock('fs/promises', () => ({
  mkdtemp: jest.fn().mockResolvedValue('/tmp/streamtube-xyz'),
  readFile: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff])),
  rm: jest.fn().mockResolvedValue(undefined),
}));

import { Job } from 'bullmq';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { VideosService } from '../videos.service';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';
import { ProcessVideoJobData } from './video-processing.constants';

describe('VideoProcessor (unit)', () => {
  let processor: VideoProcessor;
  let videosService: jest.Mocked<
    Pick<VideosService, 'findById' | 'markReady' | 'markError'>
  >;
  let storage: jest.Mocked<
    Pick<StorageService, 'downloadToFile' | 'putObject' | 'buildThumbnailKey'>
  >;
  let ffmpeg: jest.Mocked<Pick<FfmpegService, 'probe' | 'generateThumbnail'>>;

  const processingVideo = {
    id: 'video-1',
    status: VideoStatus.PROCESSING,
    storage_key: 'videos/video-1/original',
  } as Video;

  function makeJob(overrides: Partial<Job<ProcessVideoJobData>> = {}) {
    return {
      data: { videoId: 'video-1' },
      opts: { attempts: 3 },
      attemptsMade: 0,
      failedReason: undefined,
      ...overrides,
    } as Job<ProcessVideoJobData>;
  }

  beforeEach(() => {
    videosService = {
      findById: jest.fn(),
      markReady: jest.fn().mockResolvedValue(undefined),
      markError: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      downloadToFile: jest.fn().mockResolvedValue(undefined),
      putObject: jest.fn().mockResolvedValue(undefined),
      buildThumbnailKey: jest.fn((id: string) => `thumbnails/${id}/thumb.jpg`),
    };
    ffmpeg = {
      probe: jest.fn().mockResolvedValue({
        durationSeconds: 10,
        width: 1280,
        height: 720,
        codec: 'h264',
        bitrate: 1000,
        format: 'mp4',
      }),
      generateThumbnail: jest.fn().mockResolvedValue(undefined),
    };
    processor = new VideoProcessor(
      videosService as unknown as VideosService,
      storage as unknown as StorageService,
      ffmpeg as unknown as FfmpegService,
    );
  });

  it('downloads, probes, generates a thumbnail, uploads it, and marks ready', async () => {
    videosService.findById.mockResolvedValueOnce({ ...processingVideo });

    await processor.process(makeJob());

    expect(storage.downloadToFile).toHaveBeenCalledWith(
      'videos/video-1/original',
      expect.any(String),
    );
    expect(ffmpeg.probe).toHaveBeenCalled();
    expect(ffmpeg.generateThumbnail).toHaveBeenCalled();
    expect(storage.putObject).toHaveBeenCalledWith(
      'thumbnails/video-1/thumb.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(videosService.markReady).toHaveBeenCalledWith('video-1', {
      durationSeconds: 10,
      metadata: {
        width: 1280,
        height: 720,
        codec: 'h264',
        bitrate: 1000,
        format: 'mp4',
      },
      thumbnailKey: 'thumbnails/video-1/thumb.jpg',
    });
  });

  it('is a no-op when the video is not in processing state', async () => {
    videosService.findById.mockResolvedValueOnce({
      ...processingVideo,
      status: VideoStatus.READY,
    });

    await processor.process(makeJob());

    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(videosService.markReady).not.toHaveBeenCalled();
  });

  it('marks error after attempts are exhausted', async () => {
    await processor.onFailed(
      makeJob({ attemptsMade: 3, failedReason: 'ffprobe crashed' }),
    );

    expect(videosService.markError).toHaveBeenCalledWith(
      'video-1',
      'ffprobe crashed',
    );
  });

  it('does not mark error before attempts are exhausted', async () => {
    await processor.onFailed(
      makeJob({ attemptsMade: 1, failedReason: 'transient' }),
    );

    expect(videosService.markError).not.toHaveBeenCalled();
  });
});
