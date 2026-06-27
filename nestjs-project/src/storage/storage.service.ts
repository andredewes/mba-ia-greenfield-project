import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import storageConfig from '../config/storage.config';

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface RangedObject {
  stream: Readable;
  contentLength: number;
  contentType?: string;
  contentRange?: string;
  isPartial: boolean;
}

const ENSURE_BUCKET_MAX_ATTEMPTS = 15;
const ENSURE_BUCKET_RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    });
    this.bucket = config.bucket;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    for (let attempt = 1; attempt <= ENSURE_BUCKET_MAX_ATTEMPTS; attempt++) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        return;
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode;
        const name = (err as { name?: string }).name;
        if (status === 404 || name === 'NotFound' || name === 'NoSuchBucket') {
          try {
            await this.client.send(
              new CreateBucketCommand({ Bucket: this.bucket }),
            );
            return;
          } catch (createErr) {
            const createName = (createErr as { name?: string }).name;
            if (
              createName === 'BucketAlreadyOwnedByYou' ||
              createName === 'BucketAlreadyExists'
            ) {
              return;
            }
            if (attempt === ENSURE_BUCKET_MAX_ATTEMPTS) throw createErr;
          }
        } else if (attempt === ENSURE_BUCKET_MAX_ATTEMPTS) {
          throw err;
        }
        await sleep(ENSURE_BUCKET_RETRY_DELAY_MS);
      }
    }
  }

  buildOriginalKey(videoId: string): string {
    return `videos/${videoId}/original`;
  }

  buildThumbnailKey(videoId: string): string {
    return `thumbnails/${videoId}/thumb.jpg`;
  }

  async createMultipartUpload(
    key: string,
    contentType?: string,
  ): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!res.UploadId) {
      throw new Error('CreateMultipartUpload did not return an UploadId');
    }
    return res.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: this.config.uploadPresignExpirySeconds,
    });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(
    key: string,
  ): Promise<{ contentLength: number; contentType?: string }> {
    const res = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return {
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType,
    };
  }

  async getObjectRange(key: string, range?: string): Promise<RangedObject> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }),
    );
    return {
      stream: res.Body as Readable,
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType,
      contentRange: res.ContentRange,
      isPartial: res.$metadata.httpStatusCode === 206,
    };
  }

  async presignDownload(key: string, filename: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: this.config.downloadPresignExpirySeconds,
    });
  }

  async putObject(
    key: string,
    body: Buffer | Readable,
    contentType?: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async downloadToFile(key: string, destPath: string): Promise<void> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    await pipeline(res.Body as Readable, createWriteStream(destPath));
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
