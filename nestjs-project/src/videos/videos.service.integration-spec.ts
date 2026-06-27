import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { DataSource, Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';
import { VIDEO_PROCESSING_QUEUE } from './processing/video-processing.constants';
import { VideoNotOwnedException } from './exceptions/video.exceptions';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — MinIO + Postgres + Redis)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let queue: Queue;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: cfg.redisHost, port: cfg.redisPort },
          }),
        }),
        VideosModule,
      ],
    }).compile();

    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(getDataSourceToken());
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    await storage.ensureBucket();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  async function seedChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `v_${randomUUID()}@test.local`,
        password: 'hash',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'nick',
        nickname: `nick_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
  }

  it('initiateUpload persists a draft with an upload_id and presigned parts', async () => {
    const channel = await seedChannel();

    const result = await service.initiateUpload(channel.user_id, {
      title: 'Integration video',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      fileSize: 1024,
    });

    expect(result.parts.length).toBeGreaterThanOrEqual(1);
    const persisted = await videoRepository.findOneByOrFail({
      id: result.videoId,
    });
    expect(persisted.status).toBe(VideoStatus.DRAFT);
    expect(persisted.upload_id).toBe(result.uploadId);
    expect(persisted.public_id).toBe(result.publicId);
  });

  it('completes a real multipart upload and enqueues a processing job', async () => {
    const channel = await seedChannel();
    const payload = new Uint8Array(
      Buffer.from('integration multipart video bytes'),
    );

    const init = await service.initiateUpload(channel.user_id, {
      title: 'Full flow',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      fileSize: payload.length,
    });

    const putRes = await fetch(init.parts[0].url, {
      method: 'PUT',
      body: payload,
    });
    const etag = putRes.headers.get('etag') as string;

    const completed = await service.completeUpload(
      channel.user_id,
      init.videoId,
      [{ partNumber: 1, etag }],
    );

    expect(completed.status).toBe(VideoStatus.PROCESSING);
    expect(completed.size_bytes).toBe(String(payload.length));
    expect(completed.upload_id).toBeNull();

    const job = await queue.getJob(init.videoId);
    expect(job?.data).toEqual({ videoId: init.videoId });
  });

  it('rejects completion by a non-owner', async () => {
    const owner = await seedChannel();
    const other = await seedChannel();

    const init = await service.initiateUpload(owner.user_id, {
      title: 'Owned',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      fileSize: 16,
    });

    await expect(
      service.completeUpload(other.user_id, init.videoId, [
        { partNumber: 1, etag: 'x' },
      ]),
    ).rejects.toBeInstanceOf(VideoNotOwnedException);
  });

  it('markReady and markError persist terminal states', async () => {
    const channel = await seedChannel();
    const init = await service.initiateUpload(channel.user_id, {
      title: 'States',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      fileSize: 16,
    });

    await service.markReady(init.videoId, {
      durationSeconds: 10,
      metadata: { width: 640, height: 480, codec: 'h264' },
      thumbnailKey: storage.buildThumbnailKey(init.videoId),
    });
    let video = await videoRepository.findOneByOrFail({ id: init.videoId });
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.duration_seconds).toBe(10);

    await service.markError(init.videoId, 'boom');
    video = await videoRepository.findOneByOrFail({ id: init.videoId });
    expect(video.status).toBe(VideoStatus.ERROR);
    expect(video.error_reason).toBe('boom');
  });
});
