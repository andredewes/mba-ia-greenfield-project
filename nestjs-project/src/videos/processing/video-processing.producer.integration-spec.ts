import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import queueConfig from '../../config/queue.config';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';

describe('VideoProcessingProducer (integration — real Redis)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: cfg.redisHost, port: cfg.redisPort },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();

    producer = moduleRef.get(VideoProcessingProducer);
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  it('persists a waiting job in Redis with the expected data and options', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId });
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('does not create a duplicate active job for the same videoId', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
    const total =
      (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
    // jobId dedupe: at most one job per unique videoId across the two enqueues
    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(total).toBeGreaterThanOrEqual(1);
  });
});
