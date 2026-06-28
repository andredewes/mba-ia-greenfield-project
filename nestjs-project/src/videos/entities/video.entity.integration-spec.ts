import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `u${randomUUID()}@test.local`,
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

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('defaults status to draft and persists required fields', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: `pid_${randomUUID().slice(0, 8)}`,
        channel_id: channel.id,
        title: 'My first video',
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.storage_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
  });

  it('enforces a unique public_id', async () => {
    const channel = await createChannel();
    const publicId = `pid_${randomUUID().slice(0, 8)}`;
    await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'A',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: publicId,
          channel_id: channel.id,
          title: 'B',
        }),
      ),
    ).rejects.toThrow();
  });

  it('stores bigint size_bytes beyond 2^31 and jsonb metadata', async () => {
    const channel = await createChannel();
    const tenGb = '10737418240';
    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: `pid_${randomUUID().slice(0, 8)}`,
        channel_id: channel.id,
        title: 'Big',
        size_bytes: tenGb,
        duration_seconds: 3600,
        metadata: { width: 1920, height: 1080, codec: 'h264', bitrate: 5000 },
        status: VideoStatus.READY,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(tenGb);
    expect(found.metadata).toEqual({
      width: 1920,
      height: 1080,
      codec: 'h264',
      bitrate: 5000,
    });
  });

  it('rejects an invalid status enum value', async () => {
    const channel = await createChannel();
    await expect(
      videoRepository.query(
        `INSERT INTO "videos" ("public_id", "channel_id", "title", "status") VALUES ($1, $2, $3, $4)`,
        [`pid_${randomUUID().slice(0, 8)}`, channel.id, 'X', 'bogus'],
      ),
    ).rejects.toThrow();
  });
});
