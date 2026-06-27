import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

interface VideoResponse {
  id: string;
  publicId: string;
  title: string;
  status: string;
  durationSeconds: number | null;
  sizeBytes: string | null;
  mimeType: string | null;
  originalFilename: string | null;
  metadata: Video['metadata'];
  channelId: string;
  createdAt: Date;
  updatedAt: Date;
}

function toVideoResponse(video: Video): VideoResponse {
  return {
    id: video.id,
    publicId: video.public_id,
    title: video.title,
    status: video.status,
    durationSeconds: video.duration_seconds,
    sizeBytes: video.size_bytes,
    mimeType: video.mime_type,
    originalFilename: video.original_filename,
    metadata: video.metadata,
    channelId: video.channel_id,
    createdAt: video.created_at,
    updatedAt: video.updated_at,
  };
}

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft for the caller channel and returns presigned multipart upload URLs.',
  })
  @ApiResponse({ status: 201, description: 'Upload initiated' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ) {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload, verifies the stored object, flips the video to processing, and enqueues processing.',
  })
  @ApiResponse({ status: 202, description: 'Upload completed; processing queued' })
  @ApiResponse({
    status: 403,
    description: 'Video does not belong to the current user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; publicId: string; status: string }> {
    const video = await this.videosService.completeUpload(
      user.sub,
      id,
      dto.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    );
    return { id: video.id, publicId: video.public_id, status: video.status };
  }

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the caller's videos" })
  @ApiResponse({ status: 200, description: 'List of the caller videos' })
  async list(@CurrentUser() user: JwtPayload): Promise<VideoResponse[]> {
    const videos = await this.videosService.listByUser(user.sub);
    return videos.map(toVideoResponse);
  }

  @Public()
  @Get(':publicId')
  @ApiOperation({ summary: 'Get public video metadata' })
  @ApiResponse({ status: 200, description: 'Video metadata' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getOne(
    @Param('publicId') publicId: string,
  ): Promise<VideoResponse> {
    const video = await this.videosService.findByPublicIdOrThrow(publicId);
    return toVideoResponse(video);
  }

  @Public()
  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Stream the video',
    description:
      'Serves the video with HTTP range support (206 Partial Content) so playback can start without a full download. Only ready videos are streamable.',
  })
  @ApiResponse({ status: 206, description: 'Partial content' })
  @ApiResponse({ status: 200, description: 'Full content (no range header)' })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('publicId') publicId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { video, ranged } = await this.videosService.getPlaybackStream(
      publicId,
      req.headers.range,
    );
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Content-Type',
      video.mime_type ?? ranged.contentType ?? 'application/octet-stream',
    );
    res.setHeader('Content-Length', String(ranged.contentLength));
    if (ranged.isPartial && ranged.contentRange) {
      res.setHeader('Content-Range', ranged.contentRange);
      res.status(HttpStatus.PARTIAL_CONTENT);
    } else {
      res.status(HttpStatus.OK);
    }
    ranged.stream.pipe(res);
  }

  @Public()
  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Download the video',
    description:
      'Redirects to a short-lived presigned URL that downloads the original file as an attachment. Only ready videos are downloadable.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to presigned download URL' })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.getDownloadUrl(publicId);
    res.redirect(HttpStatus.FOUND, url);
  }
}
