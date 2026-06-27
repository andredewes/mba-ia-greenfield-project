import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationSeconds: number;
  width?: number;
  height?: number;
  codec?: string;
  bitrate?: number;
  format?: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string; format_name?: string };
}

@Injectable()
export class FfmpegService {
  async probe(inputPath: string): Promise<ProbeResult> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ]);
    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = (parsed.streams ?? []).find(
      (s) => s.codec_type === 'video',
    );
    const duration = parseFloat(
      parsed.format?.duration ?? videoStream?.duration ?? '0',
    );
    return {
      durationSeconds: Math.round(Number.isFinite(duration) ? duration : 0),
      width: videoStream?.width,
      height: videoStream?.height,
      codec: videoStream?.codec_name,
      bitrate: parsed.format?.bit_rate
        ? parseInt(parsed.format.bit_rate, 10)
        : undefined,
      format: parsed.format?.format_name,
    };
  }

  async generateThumbnail(
    inputPath: string,
    outputPath: string,
    offsetSeconds: number,
  ): Promise<void> {
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      String(offsetSeconds),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outputPath,
    ]);
  }
}
