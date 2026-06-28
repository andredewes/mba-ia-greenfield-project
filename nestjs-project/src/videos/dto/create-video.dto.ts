import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_VIDEO_UPLOAD_BYTES } from '../video-upload.constants';

export class CreateVideoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsNotEmpty()
  filename: string;

  @IsString()
  @IsNotEmpty()
  contentType: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_UPLOAD_BYTES)
  fileSize: number;
}
