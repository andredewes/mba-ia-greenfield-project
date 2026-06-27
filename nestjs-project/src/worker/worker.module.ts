import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import mailConfig from '../config/mail.config';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import swaggerConfig from '../config/swagger.config';
import { envValidationSchema } from '../config/env.validation';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { User } from '../users/entities/user.entity';
import { FfmpegService } from '../videos/processing/ffmpeg.service';
import { VideoProcessor } from '../videos/processing/video.processor';
import { VIDEO_PROCESSING_QUEUE } from '../videos/processing/video-processing.constants';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        storageConfig,
        queueConfig,
        swaggerConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.redisHost, port: cfg.redisPort },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    TypeOrmModule.forFeature([User]),
    StorageModule,
    VideosModule,
  ],
  providers: [FfmpegService, VideoProcessor],
})
export class WorkerModule {}
