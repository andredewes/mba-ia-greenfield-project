import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/url'),
}));

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

async function buildService(): Promise<StorageService> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] })],
    providers: [StorageService],
  }).compile();
  return moduleRef.get(StorageService);
}

describe('StorageService (unit)', () => {
  let service: StorageService;
  let sendSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    service = await buildService();
    sendSpy = jest.spyOn(S3Client.prototype, 'send');
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  describe('key builders', () => {
    it('builds the original key scoped by video id', () => {
      expect(service.buildOriginalKey('abc')).toBe('videos/abc/original');
    });

    it('builds the thumbnail key scoped by video id', () => {
      expect(service.buildThumbnailKey('abc')).toBe('thumbnails/abc/thumb.jpg');
    });
  });

  describe('ensureBucket', () => {
    it('does not create the bucket when HeadBucket succeeds', async () => {
      sendSpy.mockResolvedValueOnce({} as never);

      await service.ensureBucket();

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    });

    it('creates the bucket when HeadBucket returns 404', async () => {
      sendSpy
        .mockRejectedValueOnce({
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        } as never)
        .mockResolvedValueOnce({} as never);

      await service.ensureBucket();

      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy.mock.calls[1][0]).toBeInstanceOf(CreateBucketCommand);
    });
  });

  describe('createMultipartUpload', () => {
    it('returns the UploadId from the command response', async () => {
      sendSpy.mockResolvedValueOnce({ UploadId: 'upload-123' } as never);

      const uploadId = await service.createMultipartUpload(
        'videos/a/original',
        'video/mp4',
      );

      expect(uploadId).toBe('upload-123');
      expect(sendSpy.mock.calls[0][0]).toBeInstanceOf(
        CreateMultipartUploadCommand,
      );
    });

    it('throws when no UploadId is returned', async () => {
      sendSpy.mockResolvedValueOnce({} as never);

      await expect(
        service.createMultipartUpload('videos/a/original'),
      ).rejects.toThrow('UploadId');
    });
  });

  describe('presignUploadPart', () => {
    it('delegates to getSignedUrl with the configured expiry', async () => {
      const url = await service.presignUploadPart('k', 'u', 1);

      expect(url).toBe('https://signed.example/url');
      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 21600 },
      );
    });
  });

  describe('getObjectRange', () => {
    it('maps a partial (206) response to isPartial=true with headers', async () => {
      sendSpy.mockResolvedValueOnce({
        Body: { on: jest.fn() },
        ContentLength: 100,
        ContentType: 'video/mp4',
        ContentRange: 'bytes 0-99/500',
        $metadata: { httpStatusCode: 206 },
      } as never);

      const result = await service.getObjectRange('k', 'bytes=0-99');

      expect(result.isPartial).toBe(true);
      expect(result.contentLength).toBe(100);
      expect(result.contentRange).toBe('bytes 0-99/500');
      expect(result.contentType).toBe('video/mp4');
    });
  });
});
