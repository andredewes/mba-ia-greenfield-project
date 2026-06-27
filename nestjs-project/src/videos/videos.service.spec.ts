import type { ConfigType } from '@nestjs/config';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';
import { VideoProcessingProducer } from './processing/video-processing.producer';
import {
  ChannelNotFoundException,
  InvalidUploadException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';

describe('VideosService (unit)', () => {
  let service: VideosService;
  let repo: jest.Mocked<Pick<Repository<Video>, 'create' | 'save' | 'findOne' | 'find' | 'update'>>;
  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'buildOriginalKey'
      | 'createMultipartUpload'
      | 'presignUploadPart'
      | 'completeMultipartUpload'
      | 'abortMultipartUpload'
      | 'headObject'
    >
  >;
  let channels: jest.Mocked<Pick<ChannelsService, 'findByUserId'>>;
  let producer: jest.Mocked<Pick<VideoProcessingProducer, 'enqueue'>>;

  const channel = { id: 'channel-1' } as Channel;
  const storageCfg = { uploadPartSizeBytes: 100 } as ConfigType<
    typeof storageConfig
  >;

  beforeEach(() => {
    repo = {
      create: jest.fn((v) => ({ id: 'video-1', ...v }) as Video),
      save: jest.fn((v: Video) => Promise.resolve(v)),
      findOne: jest.fn(),
      find: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      buildOriginalKey: jest.fn((id: string) => `videos/${id}/original`),
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadPart: jest
        .fn()
        .mockImplementation((_k, _u, n: number) =>
          Promise.resolve(`https://signed/part/${n}`),
        ),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 12345 }),
    };
    channels = { findByUserId: jest.fn().mockResolvedValue(channel) };
    producer = { enqueue: jest.fn().mockResolvedValue(undefined) };

    service = new VideosService(
      repo as unknown as Repository<Video>,
      storage as unknown as StorageService,
      channels as unknown as ChannelsService,
      producer as unknown as VideoProcessingProducer,
      storageCfg,
    );
  });

  describe('initiateUpload', () => {
    it('creates a draft and presigns ceil(fileSize/partSize) parts', async () => {
      const result = await service.initiateUpload('user-1', {
        title: 'T',
        filename: 'v.mp4',
        contentType: 'video/mp4',
        fileSize: 250,
      });

      expect(result.videoId).toBe('video-1');
      expect(result.uploadId).toBe('upload-1');
      expect(result.partSize).toBe(100);
      expect(result.parts).toHaveLength(3); // ceil(250/100)
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'video/mp4',
      );
      const draft = repo.create.mock.results[0].value as Video;
      expect(draft.status).toBe(VideoStatus.DRAFT);
    });

    it('throws ChannelNotFoundException when the user has no channel', async () => {
      channels.findByUserId.mockResolvedValueOnce(null);
      await expect(
        service.initiateUpload('user-1', {
          title: 'T',
          filename: 'v.mp4',
          contentType: 'video/mp4',
          fileSize: 1,
        }),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
    });
  });

  describe('completeUpload', () => {
    const draftVideo = {
      id: 'video-1',
      channel_id: 'channel-1',
      status: VideoStatus.DRAFT,
      storage_key: 'videos/video-1/original',
      upload_id: 'upload-1',
    } as Video;

    it('completes multipart, records size, flips to processing, and enqueues', async () => {
      repo.findOne.mockResolvedValueOnce({ ...draftVideo });

      const saved = await service.completeUpload('user-1', 'video-1', [
        { partNumber: 1, etag: 'e1' },
      ]);

      expect(storage.completeMultipartUpload).toHaveBeenCalled();
      expect(storage.headObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(saved.size_bytes).toBe('12345');
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      expect(saved.upload_id).toBeNull();
      expect(producer.enqueue).toHaveBeenCalledWith('video-1');
    });

    it('throws VideoNotOwnedException for a video owned by another channel', async () => {
      repo.findOne.mockResolvedValueOnce({
        ...draftVideo,
        channel_id: 'other-channel',
      });

      await expect(
        service.completeUpload('user-1', 'video-1', [
          { partNumber: 1, etag: 'e1' },
        ]),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('throws InvalidUploadException when the video is not a draft', async () => {
      repo.findOne.mockResolvedValueOnce({
        ...draftVideo,
        status: VideoStatus.READY,
      });

      await expect(
        service.completeUpload('user-1', 'video-1', [
          { partNumber: 1, etag: 'e1' },
        ]),
      ).rejects.toBeInstanceOf(InvalidUploadException);
    });

    it('aborts the upload and throws when multipart completion fails', async () => {
      repo.findOne.mockResolvedValueOnce({ ...draftVideo });
      storage.completeMultipartUpload.mockRejectedValueOnce(
        new Error('boom'),
      );

      await expect(
        service.completeUpload('user-1', 'video-1', [
          { partNumber: 1, etag: 'e1' },
        ]),
      ).rejects.toBeInstanceOf(InvalidUploadException);
      expect(storage.abortMultipartUpload).toHaveBeenCalled();
      expect(producer.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('lookups', () => {
    it('getOwnedOrThrow throws VideoNotFoundException when missing', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getOwnedOrThrow('user-1', 'missing'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('getReadyForPlayback throws VideoNotReadyException when not ready', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 'v',
        status: VideoStatus.PROCESSING,
      } as Video);
      await expect(
        service.getReadyForPlayback('pid'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
    });
  });

  describe('worker transitions', () => {
    it('markReady updates status, duration, metadata, and thumbnail', async () => {
      await service.markReady('video-1', {
        durationSeconds: 42,
        metadata: { width: 1920, height: 1080 },
        thumbnailKey: 'thumbnails/video-1/thumb.jpg',
      });
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        expect.objectContaining({
          status: VideoStatus.READY,
          duration_seconds: 42,
          thumbnail_key: 'thumbnails/video-1/thumb.jpg',
        }),
      );
    });

    it('markError sets status error and reason', async () => {
      await service.markError('video-1', 'ffmpeg failed');
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        { status: VideoStatus.ERROR, error_reason: 'ffmpeg failed' },
      );
    });
  });
});
