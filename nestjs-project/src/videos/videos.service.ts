import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { ChannelsService } from '../channels/channels.service';
import {
  StorageService,
  RangedObject,
  UploadedPart,
} from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoMetadata, VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidUploadException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { generatePublicId } from './public-id.util';
import { VideoProcessingProducer } from './processing/video-processing.producer';

const PG_UNIQUE_VIOLATION = '23505';
const MAX_PUBLIC_ID_RETRIES = 5;

function isPublicIdUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as unknown as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes('public_id')
  );
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface InitiateUploadResult {
  videoId: string;
  publicId: string;
  uploadId: string;
  partSize: number;
  parts: PresignedPart[];
}

export interface ProcessingResult {
  durationSeconds: number;
  metadata: VideoMetadata;
  thumbnailKey: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    private readonly producer: VideoProcessingProducer,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    const video = await this.createDraftWithUniquePublicId(channel.id, dto);
    const key = this.storageService.buildOriginalKey(video.id);
    const uploadId = await this.storageService.createMultipartUpload(
      key,
      dto.contentType,
    );

    const partSize = this.storageCfg.uploadPartSizeBytes;
    const partCount = Math.max(1, Math.ceil(dto.fileSize / partSize));
    const parts: PresignedPart[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await this.storageService.presignUploadPart(
        key,
        uploadId,
        partNumber,
      );
      parts.push({ partNumber, url });
    }

    video.storage_key = key;
    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    return {
      videoId: video.id,
      publicId: video.public_id,
      uploadId,
      partSize,
      parts,
    };
  }

  private async createDraftWithUniquePublicId(
    channelId: string,
    dto: CreateVideoDto,
  ): Promise<Video> {
    for (let attempt = 0; attempt <= MAX_PUBLIC_ID_RETRIES; attempt++) {
      const video = this.videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channelId,
        title: dto.title,
        original_filename: dto.filename,
        mime_type: dto.contentType,
        status: VideoStatus.DRAFT,
      });
      try {
        return await this.videoRepository.save(video);
      } catch (err) {
        if (isPublicIdUniqueViolation(err) && attempt < MAX_PUBLIC_ID_RETRIES) {
          continue;
        }
        throw err;
      }
    }
    throw new Error('Could not generate a unique public_id');
  }

  async completeUpload(
    userId: string,
    videoId: string,
    parts: UploadedPart[],
  ): Promise<Video> {
    const video = await this.getOwnedOrThrow(userId, videoId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidUploadException('Video is not in a draft state');
    }
    if (!video.storage_key || !video.upload_id) {
      throw new InvalidUploadException('No in-flight upload for this video');
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id,
        parts,
      );
    } catch {
      await this.storageService
        .abortMultipartUpload(video.storage_key, video.upload_id)
        .catch(() => undefined);
      throw new InvalidUploadException(
        'Multipart upload could not be completed',
      );
    }

    const head = await this.storageService.headObject(video.storage_key);
    video.size_bytes = String(head.contentLength);
    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    const saved = await this.videoRepository.save(video);

    await this.producer.enqueue(video.id);
    return saved;
  }

  async getOwnedOrThrow(userId: string, videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new VideoNotOwnedException();
    }
    return video;
  }

  async findByPublicIdOrThrow(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  async getReadyForPlayback(publicId: string): Promise<Video> {
    const video = await this.findByPublicIdOrThrow(publicId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  async getPlaybackStream(
    publicId: string,
    range?: string,
  ): Promise<{ video: Video; ranged: RangedObject }> {
    const video = await this.getReadyForPlayback(publicId);
    const ranged = await this.storageService.getObjectRange(
      video.storage_key as string,
      range,
    );
    return { video, ranged };
  }

  async getDownloadUrl(publicId: string): Promise<string> {
    const video = await this.getReadyForPlayback(publicId);
    const filename = video.original_filename ?? `${video.public_id}.mp4`;
    return this.storageService.presignDownload(
      video.storage_key as string,
      filename,
    );
  }

  async listByUser(userId: string): Promise<Video[]> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) return [];
    return this.videoRepository.find({
      where: { channel_id: channel.id },
      order: { created_at: 'DESC' },
    });
  }

  async findById(videoId: string): Promise<Video | null> {
    return this.videoRepository.findOne({ where: { id: videoId } });
  }

  async markReady(videoId: string, result: ProcessingResult): Promise<void> {
    await this.videoRepository.update(
      { id: videoId },
      {
        status: VideoStatus.READY,
        duration_seconds: result.durationSeconds,
        metadata: result.metadata,
        thumbnail_key: result.thumbnailKey,
        error_reason: null,
      },
    );
  }

  async markError(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId },
      { status: VideoStatus.ERROR, error_reason: reason },
    );
  }
}
