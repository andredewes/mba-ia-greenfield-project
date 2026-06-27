jest.mock('child_process', () => ({ execFile: jest.fn() }));

import { execFile } from 'child_process';
import { FfmpegService } from './ffmpeg.service';

const mockedExecFile = execFile as unknown as jest.Mock;

describe('FfmpegService (unit)', () => {
  let service: FfmpegService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FfmpegService();
  });

  describe('probe', () => {
    it('parses ffprobe JSON into the metadata shape', async () => {
      const probeJson = JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
          },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
        format: {
          duration: '12.84',
          bit_rate: '4500000',
          format_name: 'mov,mp4,m4a',
        },
      });
      mockedExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (e: unknown, r: unknown) => void) =>
          cb(null, { stdout: probeJson, stderr: '' }),
      );

      const result = await service.probe('/tmp/in.mp4');

      expect(result.durationSeconds).toBe(13);
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.codec).toBe('h264');
      expect(result.bitrate).toBe(4500000);
      expect(mockedExecFile.mock.calls[0][0]).toBe('ffprobe');
    });
  });

  describe('generateThumbnail', () => {
    it('invokes ffmpeg with a single-frame capture at the offset', async () => {
      mockedExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (e: unknown, r: unknown) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );

      await service.generateThumbnail('/tmp/in.mp4', '/tmp/out.jpg', 1);

      const [cmd, args] = mockedExecFile.mock.calls[0];
      expect(cmd).toBe('ffmpeg');
      expect(args).toEqual([
        '-y',
        '-ss',
        '1',
        '-i',
        '/tmp/in.mp4',
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '/tmp/out.jpg',
      ]);
    });
  });
});
