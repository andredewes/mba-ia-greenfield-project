import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

describe('StorageService (integration — real MinIO)', () => {
  let service: StorageService;
  const keys: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();
    service = moduleRef.get(StorageService);
    // onModuleInit (ensureBucket) is not auto-run by createTestingModule
    await service.ensureBucket();
  });

  afterAll(async () => {
    for (const key of keys) {
      await service.deleteObject(key).catch(() => undefined);
    }
  });

  it('ensureBucket is idempotent', async () => {
    await expect(service.ensureBucket()).resolves.toBeUndefined();
  });

  it('round-trips a multipart upload and verifies size via headObject', async () => {
    const key = `test/${randomUUID()}/original`;
    keys.push(key);
    const payload = new Uint8Array(
      Buffer.from('hello streamtube multipart upload payload'),
    );

    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    const url = await service.presignUploadPart(key, uploadId, 1);

    const putRes = await fetch(url, { method: 'PUT', body: payload });
    expect(putRes.status).toBe(200);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag as string },
    ]);

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(payload.length);
  });

  it('returns the requested byte range with 206 semantics', async () => {
    const key = `test/${randomUUID()}/original`;
    keys.push(key);
    const payload = new Uint8Array(Buffer.from('0123456789ABCDEFGHIJ')); // 20 bytes

    const uploadId = await service.createMultipartUpload(key);
    const url = await service.presignUploadPart(key, uploadId, 1);
    const putRes = await fetch(url, { method: 'PUT', body: payload });
    const etag = putRes.headers.get('etag') as string;
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);

    const ranged = await service.getObjectRange(key, 'bytes=0-9');
    const bytes = await streamToBuffer(ranged.stream);

    expect(ranged.isPartial).toBe(true);
    expect(bytes.length).toBe(10);
    expect(bytes.toString()).toBe('0123456789');
    expect(ranged.contentRange).toBe('bytes 0-9/20');
  });

  it('presigns a download URL that streams the object with attachment disposition', async () => {
    const key = `test/${randomUUID()}/original`;
    keys.push(key);
    const payload = new Uint8Array(Buffer.from('downloadable-content'));

    const uploadId = await service.createMultipartUpload(key);
    const url = await service.presignUploadPart(key, uploadId, 1);
    const putRes = await fetch(url, { method: 'PUT', body: payload });
    const etag = putRes.headers.get('etag') as string;
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);

    const downloadUrl = await service.presignDownload(key, 'my video.mp4');
    const res = await fetch(downloadUrl);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(await res.text()).toBe('downloadable-content');
  });

  it('aborts an in-flight multipart upload', async () => {
    const key = `test/${randomUUID()}/original`;
    const uploadId = await service.createMultipartUpload(key);
    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
  });

  it('puts and deletes a small object (thumbnail path)', async () => {
    const key = `test/${randomUUID()}/thumb.jpg`;
    await service.putObject(key, Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    const head = await service.headObject(key);
    expect(head.contentLength).toBe(3);
    await expect(service.deleteObject(key)).resolves.toBeUndefined();
  });
});
