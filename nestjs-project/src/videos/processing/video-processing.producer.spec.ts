import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import queueConfig from '../../config/queue.config';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';

describe('VideoProcessingProducer (unit)', () => {
  let producer: VideoProcessingProducer;
  const queue = { add: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingProducer,
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
        {
          provide: queueConfig.KEY,
          useValue: {
            videoProcessingAttempts: 3,
            videoProcessingBackoffMs: 5000,
          },
        },
      ],
    }).compile();
    producer = moduleRef.get(VideoProcessingProducer);
  });

  it('enqueues a process-video job with the videoId, attempts, backoff, and jobId', async () => {
    await producer.enqueue('video-1');

    expect(queue.add).toHaveBeenCalledWith(
      PROCESS_VIDEO_JOB,
      { videoId: 'video-1' },
      {
        jobId: 'video-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  });
});
