import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/mail/mail.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/processing/video-processing.constants';

jest.setTimeout(60000);

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    server = app.getHttpServer();
    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    if (queue) await queue.obliterate({ force: true });
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
  });

  async function registerAndLogin(
    email = `owner_${randomUUID()}@test.local`,
    password = 'password123',
  ): Promise<string> {
    const mailService = app.get(MailService);
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
      });
    await request(server).post('/auth/register').send({ email, password });
    await request(server).get('/auth/confirm-email').query({ token });
    const res = await request(server)
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  async function initiateAndUpload(
    token: string,
    payload: Buffer,
  ): Promise<{ videoId: string; publicId: string }> {
    const init = await request(server)
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'My clip',
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        fileSize: payload.length,
      })
      .expect(201);

    const putRes = await fetch(init.body.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(payload),
    });
    const etag = putRes.headers.get('etag') as string;

    await request(server)
      .post(`/videos/${init.body.videoId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(202);

    return { videoId: init.body.videoId, publicId: init.body.publicId };
  }

  it('rejects upload initiation without a token', async () => {
    await request(server)
      .post('/videos')
      .send({
        title: 'T',
        filename: 'v.mp4',
        contentType: 'video/mp4',
        fileSize: 10,
      })
      .expect(401);
  });

  it('initiates an upload and returns presigned parts', async () => {
    const token = await registerAndLogin();
    const res = await request(server)
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Hello',
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        fileSize: 2048,
      })
      .expect(201);

    expect(res.body.videoId).toBeDefined();
    expect(res.body.publicId).toHaveLength(12);
    expect(res.body.parts.length).toBeGreaterThanOrEqual(1);
    expect(res.body.parts[0].url).toContain('http');
  });

  it('rejects invalid upload bodies', async () => {
    const token = await registerAndLogin();
    await request(server)
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '', filename: 'v.mp4', contentType: 'video/mp4' })
      .expect(400);
  });

  it('completes an upload and flips the video to processing', async () => {
    const token = await registerAndLogin();
    const payload = Buffer.from('hello video');
    const { publicId } = await initiateAndUpload(token, payload);

    const meta = await request(server).get(`/videos/${publicId}`).expect(200);
    expect(meta.body.status).toBe('processing');
    expect(meta.body.sizeBytes).toBe(String(payload.length));
  });

  it('rejects completion by a non-owner with 403', async () => {
    const ownerToken = await registerAndLogin();
    const init = await request(server)
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'T',
        filename: 'v.mp4',
        contentType: 'video/mp4',
        fileSize: 10,
      })
      .expect(201);

    const otherToken = await registerAndLogin();
    await request(server)
      .post(`/videos/${init.body.videoId}/complete`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ parts: [{ partNumber: 1, etag: 'x' }] })
      .expect(403);
  });

  it('lists only the caller videos', async () => {
    const tokenA = await registerAndLogin();
    await request(server)
      .post('/videos')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: 'A1',
        filename: 'a.mp4',
        contentType: 'video/mp4',
        fileSize: 10,
      })
      .expect(201);

    const tokenB = await registerAndLogin();
    await request(server)
      .post('/videos')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        title: 'B1',
        filename: 'b.mp4',
        contentType: 'video/mp4',
        fileSize: 10,
      })
      .expect(201);

    const listA = await request(server)
      .get('/videos')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].title).toBe('A1');
  });

  it('returns 404 for unknown public id metadata', async () => {
    await request(server).get('/videos/unknownpublic').expect(404);
  });

  it('streams a ready video with range (206) and without range (200)', async () => {
    const token = await registerAndLogin();
    const payload = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes
    const { videoId, publicId } = await initiateAndUpload(token, payload);
    await dataSource
      .getRepository(Video)
      .update({ id: videoId }, { status: VideoStatus.READY });

    const partial = await request(server)
      .get(`/videos/${publicId}/stream`)
      .set('Range', 'bytes=0-9')
      .expect(206);
    expect(partial.headers['content-range']).toBe('bytes 0-9/20');
    expect(partial.headers['accept-ranges']).toBe('bytes');
    expect(partial.body.length ?? partial.text.length).toBe(10);

    const full = await request(server)
      .get(`/videos/${publicId}/stream`)
      .expect(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
  });

  it('redirects a ready video download to a presigned URL', async () => {
    const token = await registerAndLogin();
    const payload = Buffer.from('downloadable bytes');
    const { videoId, publicId } = await initiateAndUpload(token, payload);
    await dataSource
      .getRepository(Video)
      .update({ id: videoId }, { status: VideoStatus.READY });

    const res = await request(server)
      .get(`/videos/${publicId}/download`)
      .redirects(0)
      .expect(302);
    expect(res.headers['location']).toContain('http');
    expect(res.headers['location']).toContain('response-content-disposition');
  });

  it('returns 409 when streaming a non-ready video', async () => {
    const token = await registerAndLogin();
    const { publicId } = await initiateAndUpload(token, Buffer.from('x'));
    await request(server).get(`/videos/${publicId}/stream`).expect(409);
    await request(server).get(`/videos/${publicId}/download`).expect(409);
  });

  it('processes a real upload end-to-end through the worker (upload → process → ready → stream)', async () => {
    const fixture = readFileSync(join(__dirname, 'fixtures', 'sample.mp4'));
    const token = await registerAndLogin();
    const { publicId } = await initiateAndUpload(token, fixture);

    let status = 'processing';
    let body: Record<string, unknown> = {};
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const res = await request(server).get(`/videos/${publicId}`).expect(200);
      body = res.body;
      status = res.body.status;
      if (status === 'ready' || status === 'error') break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(status).toBe('ready');
    expect(body.durationSeconds).toBeGreaterThanOrEqual(1);
    expect(body.metadata).toMatchObject({ width: 320, height: 240 });

    await request(server)
      .get(`/videos/${publicId}/stream`)
      .set('Range', 'bytes=0-99')
      .expect(206);
  }, 90000);
});
