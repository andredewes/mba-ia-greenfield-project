---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-27T00:00:00-03:00"
  docs/phases/phase-03-videos/context.md: "2026-06-27T00:00:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-27T00:00:00-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the large-video upload and processing pipeline: a video is pre-registered as a draft when an upload starts, its bytes go **directly to object storage** (never through the API) via presigned multipart URLs, a background worker extracts duration/metadata and generates a thumbnail with FFmpeg, the video gets a short unique public URL, and it can then be **streamed** (HTTP range / `206`) and **downloaded**. This introduces three new infrastructure components — object storage (MinIO), a queue broker (Redis), and a separate FFmpeg worker — all via Docker Compose.

---

## Step Implementations

### SI-03.1 — Dependencies, Config Namespaces, Env, and Infra (Redis + MinIO)

**Description:** Install Phase 03 dependencies, add `storage` and `queue` config namespaces (`registerAs` pattern), extend the Joi env schema and `.env.example`, and add the **Redis** and **MinIO** services to Docker Compose. No application code yet — this is the foundation SI-03.2+ build on.

**Technical actions:**

- Install production deps in `nestjs-project`: `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`, `@nestjs/bullmq@^11`, `bullmq@^5`, `nanoid@^3` (pinned to v3 — v5 is ESM-only, see `library-refs.md`).
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading: `S3_ENDPOINT` (default `http://minio:9000`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY` (default `minioadmin`), `S3_SECRET_KEY` (default `minioadmin`), `S3_BUCKET` (default `streamtube-videos`), `S3_FORCE_PATH_STYLE` (default `true`), `UPLOAD_PART_SIZE_BYTES` (default `104857600` = 100 MiB), `UPLOAD_PRESIGN_EXPIRY_SECONDS` (default `21600` = 6h), `DOWNLOAD_PRESIGN_EXPIRY_SECONDS` (default `3600`).
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading: `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `VIDEO_PROCESSING_ATTEMPTS` (default `3`), `VIDEO_PROCESSING_BACKOFF_MS` (default `5000`).
- Update `src/config/env.validation.ts` — add all new vars to the Joi schema (all with defaults; none required, since dev defaults match the Compose service names). Update `.env.example` with the new vars and Compose-compatible defaults.
- Update `nestjs-project/compose.yaml`:
  - `redis` — image `redis:7-alpine`, healthcheck `redis-cli ping`.
  - `minio` — image `minio/minio`, command `server /data --console-address ":9001"`, env `MINIO_ROOT_USER=minioadmin` / `MINIO_ROOT_PASSWORD=minioadmin`, ports `9000:9000` (API) and `9001:9001` (console), volume `minio-data:/data`, healthcheck on `http://localhost:9000/minio/health/live`.
  - `nestjs-api` — add `redis` (service_healthy) and `minio` (service_healthy) to `depends_on`.
  - Add the named volume `minio-data`.

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings up `db`, `mailpit`, `redis`, `minio`, and `nestjs-api`; `redis` and `minio` report healthy.
- The API starts without errors with the new env vars defaulted; the existing `GET /` E2E test still passes.
- MinIO console is reachable at `localhost:9001`; the S3 API answers at `localhost:9000`.

---

### SI-03.2 — Storage Module (S3/MinIO wrapper)

**Description:** Create a reusable `StorageModule`/`StorageService` wrapping the AWS SDK v3 `S3Client`, configured for MinIO (path-style, custom endpoint). It owns bucket bootstrap, multipart-upload orchestration, presigning, ranged reads, and object writes — the single seam every storage interaction goes through (TD-01).

**Technical actions:**

- Create `src/storage/storage.module.ts` — provides and exports `StorageService`; injects `storageConfig`.
- Create `src/storage/storage.service.ts` — construct `S3Client` from `storageConfig` (`endpoint`, `region`, `credentials`, `forcePathStyle`). Implement:
  - `onModuleInit()` → `ensureBucket()`: `HeadBucketCommand`; on `NotFound`/404 issue `CreateBucketCommand` (idempotent, safe on every boot).
  - `createMultipartUpload(key, contentType)` → returns `uploadId`.
  - `presignUploadPart(key, uploadId, partNumber)` → presigned PUT URL (`UploadPartCommand`, expiry = `UPLOAD_PRESIGN_EXPIRY_SECONDS`).
  - `completeMultipartUpload(key, uploadId, parts)` and `abortMultipartUpload(key, uploadId)`.
  - `headObject(key)` → `{ contentLength, contentType }` (existence + size verification).
  - `getObjectRange(key, range?)` → `{ stream, contentLength, contentRange, contentType, totalSize }` via `GetObjectCommand` (passes `Range` through).
  - `presignDownload(key, filename)` → presigned GET URL with `ResponseContentDisposition: attachment; filename="..."` (expiry = `DOWNLOAD_PRESIGN_EXPIRY_SECONDS`).
  - `putObject(key, body, contentType)` and `deleteObject(key)` (thumbnail upload + cleanup).
  - `buildOriginalKey(videoId)` → `videos/{videoId}/original`; `buildThumbnailKey(videoId)` → `thumbnails/{videoId}/thumb.jpg`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.spec.ts` | Unit | Key builders; command construction (mocked `S3Client.send`); `ensureBucket` issues `CreateBucket` only on 404; range passthrough |
| `src/storage/storage.service.integration-spec.ts` | Integration | Against real MinIO: `ensureBucket` idempotent; multipart round-trip (create→presigned PUT→complete); `headObject` size; `getObjectRange` returns correct slice + `Content-Range`; presigned download URL streams the object |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `ensureBucket()` creates the bucket on first boot and is a no-op when it already exists.
- A multipart upload completed through the service yields an object whose `headObject` size equals the uploaded bytes.
- `getObjectRange(key, 'bytes=0-99')` returns exactly 100 bytes with a correct `Content-Range` header value.

---

### SI-03.3 — Video Entity, Migration, and Videos Module skeleton

**Description:** Create the `Video` entity (owned by a `Channel`), generate its migration, and scaffold `VideosModule` registered in `AppModule`. This establishes persistence and the status enum before service logic.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns: `id` (uuid PK generated), `public_id` (varchar, unique — the public URL handle), `channel_id` (uuid FK → channels), `title` (varchar(255)), `status` (enum `video_status`: `draft`,`processing`,`ready`,`error`, default `draft`), `original_filename` (varchar, nullable), `mime_type` (varchar, nullable), `storage_key` (varchar, nullable), `thumbnail_key` (varchar, nullable), `size_bytes` (bigint, nullable), `duration_seconds` (int, nullable), `metadata` (jsonb, nullable — codec/width/height/bitrate), `upload_id` (varchar, nullable — in-flight multipart id), `error_reason` (text, nullable), `created_at`/`updated_at`. Define `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`. Index `public_id` (unique) and `channel_id`.
- Create `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, imports `StorageModule` and `ChannelsModule`; (service/controller added in later SIs). Export `TypeOrmModule`.
- Register `VideosModule` in `AppModule` (and `StorageModule` if not transitively imported).
- Generate migration `npm run migration:generate -- src/database/migrations/CreateVideos`; review for the enum type, unique `public_id`, FK to `channels`, and `bigint`/`jsonb` columns.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `public_id`; FK to channel; `status` defaults to `draft`; enum rejects invalid values; `size_bytes` bigint; `metadata` jsonb round-trips; nullable columns |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature([Video])`, `StorageModule`, `ChannelsModule` wiring |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `migration:run` creates the `videos` table with the `video_status` enum, unique `public_id`, and FK to `channels`.
- A video defaults to `status = 'draft'`; inserting an invalid status is rejected by the enum.
- `metadata` stores and returns a JSON object; `size_bytes` holds values > 2^31 (10GB range).

---

### SI-03.4 — Processing Queue (BullMQ) and Job Contract

**Description:** Wire BullMQ against Redis (producer side in the API), define the `video-processing` queue and `process-video` job contract, and implement the producer that enqueues a job with retry/backoff (TD-03, Events/Messages spec).

**Technical actions:**

- Register `BullModule.forRootAsync` in `AppModule` — inject `queueConfig`, configure `connection: { host, port }`.
- Create `src/videos/processing/video-processing.constants.ts` — export `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, and the `ProcessVideoJobData` type `{ videoId: string }`.
- In `VideosModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`.
- Create `src/videos/processing/video-processing.producer.ts` — `VideoProcessingProducer` injecting `@InjectQueue(VIDEO_PROCESSING_QUEUE)`. `enqueue(videoId)` adds a `PROCESS_VIDEO_JOB` with `{ videoId }`, options `{ attempts: VIDEO_PROCESSING_ATTEMPTS, backoff: { type: 'exponential', delay: VIDEO_PROCESSING_BACKOFF_MS }, removeOnComplete: true, removeOnFail: false }` (failed jobs retained per TD-09). Use `jobId: videoId` for idempotent enqueue.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/video-processing.producer.spec.ts` | Unit | `enqueue` calls `queue.add` with the job name, `{ videoId }`, and the configured attempts/backoff/jobId |
| `src/videos/processing/video-processing.producer.integration-spec.ts` | Integration | Against real Redis: `enqueue` persists a waiting job retrievable from the queue with the expected data and options |

**Dependencies:** SI-03.1, SI-03.3

**Acceptance criteria:**

- Enqueuing produces a `process-video` job in Redis carrying `{ videoId }` with `attempts = 3` and exponential backoff.
- Re-enqueuing the same `videoId` does not create a duplicate active job (`jobId` dedupe).

---

### SI-03.5 — Videos Service: draft creation, completion, and status transitions

**Description:** Implement `VideosService` — the business core: resolve the caller's channel, create a draft + initiate multipart + presign parts, complete an upload (verify + enqueue), expose lookups, and the worker-facing status transitions. Add the public-id generator and the video domain exceptions.

**Technical actions:**

- Create `src/videos/public-id.util.ts` — `generatePublicId(): string` using `nanoid(12)` (URL-safe).
- Add `findByUserId(userId): Promise<Channel | null>` to `ChannelsService` (resolves the caller's channel; minimal, justified addition).
- Create `src/videos/exceptions/video.exceptions.ts` — `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`), `VideoNotOwnedException` (403 `VIDEO_NOT_OWNED`), `VideoNotReadyException` (409 `VIDEO_NOT_READY`), `InvalidUploadException` (400 `INVALID_UPLOAD`) — all extend `DomainException`.
- Create `src/videos/videos.service.ts` — inject `Repository<Video>`, `StorageService`, `ChannelsService`, `VideoProcessingProducer`. Implement:
  - `initiateUpload(userId, dto)`: resolve channel via `findByUserId` (throw if none); create `Video` (status `draft`, `public_id` via generator with regenerate-on-unique-conflict, `title`, `original_filename`, `mime_type`); compute `storage_key`; `createMultipartUpload`; compute part count from `dto.fileSize` and `UPLOAD_PART_SIZE_BYTES`; presign every part; persist `upload_id`; return `{ videoId, publicId, uploadId, partSize, parts: [{ partNumber, url }] }`.
  - `completeUpload(userId, videoId, parts)`: load video, assert ownership (channel match) else `VideoNotOwnedException`, assert status `draft` else `InvalidUploadException`; `completeMultipartUpload`; `headObject` → set `size_bytes`; set status `processing`; clear `upload_id`; `producer.enqueue(videoId)`. On storage completion failure → `abortMultipartUpload` + `InvalidUploadException`.
  - `findByPublicIdOrThrow(publicId)`; `listByUser(userId)`; `getOwnedOrThrow(userId, videoId)`.
  - Worker-facing: `markReady(videoId, { durationSeconds, metadata, thumbnailKey })`, `markError(videoId, reason)` (idempotent updates).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/public-id.util.spec.ts` | Unit | Returns a 12-char URL-safe id; high-volume uniqueness sample |
| `src/videos/videos.service.spec.ts` | Unit | initiate: creates draft, presigns N parts for a given fileSize, regenerates public_id on conflict; complete: ownership/status guards, completes + heads + enqueues; markReady/markError set fields |
| `src/videos/videos.service.integration-spec.ts` | Integration | Against MinIO + Postgres + Redis: initiate persists draft + upload_id; full multipart PUT then complete sets `processing`, `size_bytes`, and enqueues a job; ownership/status guards enforced |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `initiateUpload` persists a `draft` video with a unique `public_id` and returns presigned part URLs whose count matches `ceil(fileSize / partSize)`.
- `completeUpload` by the owner finalizes multipart, records `size_bytes` from `headObject`, flips status to `processing`, and enqueues exactly one job.
- `completeUpload` by a non-owner throws `VideoNotOwnedException`; on a non-`draft` video throws `InvalidUploadException`.

---

### SI-03.6 — Videos Controller: upload init, complete, metadata, list

**Description:** Expose the authenticated upload endpoints and read endpoints over `VideosService`, with DTOs and Swagger docs, following REST and the inherited error contract.

**Technical actions:**

- Create DTOs in `src/videos/dto/`:
  - `CreateVideoDto` — `@IsString() @MaxLength(255)` title; `@IsString()` filename; `@IsString()` contentType; `@IsInt() @Min(1) @Max(10737418240)` fileSize (≤ 10GiB).
  - `CompleteUploadDto` — `@IsArray() @ValidateNested({each:true}) @Type(() => UploadedPartDto)` parts; `UploadedPartDto` — `@IsInt() @Min(1)` partNumber, `@IsString() @IsNotEmpty()` etag.
- Create `src/videos/videos.controller.ts` — `@ApiTags('videos')`, `@Controller('videos')`:
  - `@Post()` (auth) → `initiateUpload(@CurrentUser().sub, dto)` → 201 `{ videoId, publicId, uploadId, partSize, parts }`.
  - `@Post(':id/complete')` (auth) → `completeUpload(...)` → 202 `{ id, publicId, status }`.
  - `@Get()` (auth) → `listByUser` → 200 array of the caller's videos.
  - `@Get(':publicId')` (`@Public()`) → `findByPublicIdOrThrow` → 200 video metadata.
- Register `VideosController` and `VideosService` + `VideoProcessingProducer` in `VideosModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | `POST /videos` 201 with presigned parts (auth required → 401 without token); `POST /videos/:id/complete` 202 + status `processing`, 403 for non-owner, 400 invalid body; `GET /videos` lists only caller's videos; `GET /videos/:publicId` 200 public, 404 unknown |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `POST /videos` without a token returns 401; with a token returns 201 and presigned part URLs.
- `POST /videos/:id/complete` with valid part ETags returns 202 and the video status becomes `processing`.
- `GET /videos/:publicId` is publicly reachable and returns the video metadata including `status`; unknown id returns 404 `VIDEO_NOT_FOUND`.

---

### SI-03.7 — Streaming and Download Endpoints

**Description:** Add public playback (HTTP range / `206`) and download (presigned redirect) endpoints over the original object, gated on `status = ready` (TD-07, TD-08).

**Technical actions:**

- Add to `VideosController`:
  - `@Get(':publicId/stream')` (`@Public()`) — load video; if not `ready` throw `VideoNotReadyException`; read the `Range` request header; call `storageService.getObjectRange(storage_key, range)`; set `Accept-Ranges: bytes`, `Content-Type`, `Content-Length`; when a range is present respond `206` with `Content-Range` and pipe the slice; with no range respond `200` and stream the body. Use `@Res({ passthrough: false })` (Express `Response`) to control status/headers and pipe the Node stream. Delegate all S3 work to `StorageService` (controller stays thin).
  - `@Get(':publicId/download')` (`@Public()`) — load video; if not `ready` throw `VideoNotReadyException`; build a friendly filename from `original_filename`; `presignDownload(storage_key, filename)`; `302` redirect to the presigned URL.
- Add a thin `VideosService.getReadyForPlayback(publicId)` helper returning the video or throwing `VideoNotReadyException`/`VideoNotFoundException` so the controller contains no business rules.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | With a `ready` fixture video: `GET /:publicId/stream` no-range → 200 + `Accept-Ranges`; `Range: bytes=0-99` → 206 + `Content-Range: bytes 0-99/<total>` + 100 bytes; `GET /:publicId/download` → 302 with a presigned `Location`; both → 409 `VIDEO_NOT_READY` for a non-ready video |

**Dependencies:** SI-03.5, SI-03.6

**Acceptance criteria:**

- A `Range` request to `/videos/:publicId/stream` returns `206 Partial Content` with a correct `Content-Range` and only the requested bytes — playback can start without downloading the whole file.
- `/videos/:publicId/download` returns a `302` to a presigned URL with `Content-Disposition: attachment`.
- Streaming/download of a non-`ready` video returns `409 VIDEO_NOT_READY`.

---

### SI-03.8 — Video Worker (standalone process) + FFmpeg processing

**Description:** Implement the consumer side: an FFmpeg wrapper, the BullMQ processor that extracts metadata + generates a thumbnail and drives the status to `ready`/`error`, the standalone `WorkerModule` + bootstrap, the worker Dockerfile (with FFmpeg), and the `video-worker` Compose service (TD-04, TD-05, TD-09).

**Technical actions:**

- Create `src/videos/processing/ffmpeg.service.ts` — `FfmpegService` using `child_process.execFile` (promisified):
  - `probe(inputPath)` → run `ffprobe -v quiet -print_format json -show_format -show_streams`; parse JSON → `{ durationSeconds, width, height, codec, bitrate, format }`.
  - `generateThumbnail(inputPath, outputPath, offsetSeconds)` → run `ffmpeg -y -ss <offset> -i <input> -frames:v 1 -q:v 2 <output>`.
- Create `src/videos/processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`. `process(job)`:
  1. load video by `job.data.videoId`; if missing or not `processing`, no-op (idempotent re-delivery guard).
  2. download original from storage to a temp file (`storageService.getObjectRange(key)` full-body → temp, or a dedicated `downloadToFile`).
  3. `probe` → duration/metadata; `generateThumbnail` at `min(1, duration/2)`; upload thumbnail via `putObject(buildThumbnailKey, jpgBuffer, 'image/jpeg')`.
  4. `videosService.markReady(videoId, { durationSeconds, metadata, thumbnailKey })`; clean temp files.
  - `@OnWorkerEvent('failed')` → when `job.attemptsMade >= attempts`, `videosService.markError(videoId, reason)`.
- Create `src/worker/worker.module.ts` — imports `ConfigModule`, `TypeOrmModule.forRootAsync` (same factory as `AppModule`), `BullModule.forRootAsync`, `BullModule.registerQueue`, `StorageModule`, `ChannelsModule`/`VideosModule` providers needed; provides `FfmpegService`, `VideoProcessor`, and a `VideosService` (or a focused `VideoProcessingService`) for the status transitions.
- Create `src/worker/main.ts` — `NestFactory.createApplicationContext(WorkerModule)` (no HTTP), enabling shutdown hooks; the BullMQ `Worker` starts consuming on bootstrap.
- Add `npm run start:worker` / `start:worker:dev` scripts (`nest start`/`--watch` with the worker entry, or `ts-node src/worker/main.ts`).
- Create `nestjs-project/Dockerfile.worker` — `node:25.x-slim` + `apt install ffmpeg`, runs the worker entry.
- Add `video-worker` service to `compose.yaml` — builds from `Dockerfile.worker`, same volume mount + env, `depends_on` `db`/`redis`/`minio` healthy; command runs `start:worker:dev`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/ffmpeg.service.spec.ts` | Unit | `probe` parses ffprobe JSON into the metadata shape (mocked `execFile`); `generateThumbnail` builds the correct argv |
| `src/videos/processing/video.processor.spec.ts` | Unit | `process` orchestrates download→probe→thumbnail→markReady (mocked storage/ffmpeg/service); non-`processing` video is a no-op; failure path marks error after attempts exhausted |
| `src/videos/processing/video-processing.integration-spec.ts` | Integration | Real FFmpeg + MinIO + Postgres + Redis: enqueue a job for an uploaded small fixture video → processor extracts a real duration, uploads a real thumbnail object, and the video row becomes `ready` with `duration_seconds`, `metadata`, and `thumbnail_key` set |

**Dependencies:** SI-03.5 (service transitions), SI-03.4 (queue), SI-03.2 (storage)

**Acceptance criteria:**

- `docker compose up -d` starts a `video-worker` container with `ffmpeg`/`ffprobe` available; it connects to Redis and waits for jobs.
- Processing a real uploaded fixture sets `status = ready`, a non-null `duration_seconds`, populated `metadata`, and a `thumbnail_key` pointing to a real object in MinIO.
- A job whose processing fails on every attempt leaves the video `status = error` with `error_reason` set, and the failed job is retained in Redis.

---

### SI-03.9 — End-to-end pipeline verification, DoD, and AI docs

**Description:** Verify the full pipeline end-to-end across the running stack, satisfy the Definition of Done, and update the AI/project documentation to reflect the videos module, endpoints, queue/worker, and storage.

**Technical actions:**

- Add a full-pipeline E2E (`test/videos.e2e-spec.ts`) path: register+login → `POST /videos` → PUT parts to the presigned URLs (small fixture) → `POST /:id/complete` → poll `GET /:publicId` until `ready` (worker running) → `GET /:publicId/stream` (206) → `GET /:publicId/download` (302).
- Run the Definition of Done in the container: `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit` (exit 0), `npm run lint`.
- Ensure `nest-cli.json` / build copies any runtime assets if added; confirm `npm run build` succeeds.
- Update `nestjs-project/CLAUDE.md` and root `CLAUDE.md` — add the **Videos** section: module layout, endpoints, the upload handshake, the queue/worker, MinIO/Redis services, and the new env vars.
- Update root architecture note if needed (storage/queue/worker now real).

**Dependencies:** SI-03.6, SI-03.7, SI-03.8

**Acceptance criteria:**

- The full pipeline E2E passes against the running stack (upload → process → ready → stream/download).
- `npm test`, `npm run test:e2e`, `npx tsc --noEmit` (code 0), and `npm run lint` all pass.
- `CLAUDE.md` (root + `nestjs-project`) documents the videos module, endpoints, worker/queue, and storage consistent with the code.

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal id (never public) |
| public_id | varchar | unique, not null | Short nanoid handle; the public URL identifier |
| channel_id | uuid | FK → channels.id, not null | Owning channel (one channel per user) |
| title | varchar(255) | not null | Provided at upload init |
| status | enum `video_status` | not null, default `draft` | `draft` → `processing` → `ready` \| `error` |
| original_filename | varchar | nullable | For download filename |
| mime_type | varchar | nullable | Declared content type |
| storage_key | varchar | nullable | `videos/{id}/original` once known |
| thumbnail_key | varchar | nullable | `thumbnails/{id}/thumb.jpg`, set by worker |
| size_bytes | bigint | nullable | From `HeadObject` after completion |
| duration_seconds | int | nullable | From ffprobe |
| metadata | jsonb | nullable | `{ width, height, codec, bitrate, format }` |
| upload_id | varchar | nullable | In-flight multipart upload id (cleared on complete) |
| error_reason | text | nullable | Set when status = `error` |
| created_at | timestamp | not null, auto | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`).
**Indexes:** `(public_id)` unique, `(channel_id)`.
**Enum:** `video_status` = `draft` | `processing` | `ready` | `error` (PostgreSQL enum type, mirrors the `verification_tokens.type` precedent).

---

### API Contracts

#### POST /videos (SI-03.6) — initiate upload

**Auth:** Bearer access token (owner's channel resolved from `sub`).
**Body:** `title` (string, ≤255), `filename` (string), `contentType` (string), `fileSize` (int, 1..10737418240).
**Response 201:**
- `videoId` (uuid), `publicId` (string), `uploadId` (string), `partSize` (int bytes), `parts` (array of `{ partNumber, url }` — presigned PUT URLs).

**Errors:** 401 (no token), 400 validation (bad body / fileSize > 10GiB), 404 `CHANNEL_NOT_FOUND` (caller has no channel — should not happen for a confirmed user).

#### POST /videos/:id/complete (SI-03.6) — finalize upload

**Auth:** Bearer; must own the video.
**Body:** `parts` (array of `{ partNumber (int≥1), etag (string) }`).
**Response 202:** `{ id, publicId, status: "processing" }`.
**Errors:** 401, 403 `VIDEO_NOT_OWNED`, 404 `VIDEO_NOT_FOUND`, 400 `INVALID_UPLOAD` (not in `draft`, or storage completion failed), 400 validation.

#### GET /videos (SI-03.6) — list caller's videos

**Auth:** Bearer.
**Response 200:** array of the caller's videos (id, publicId, title, status, thumbnail info, timestamps).
**Errors:** 401.

#### GET /videos/:publicId (SI-03.6) — metadata

**Auth:** Public.
**Response 200:** video metadata (publicId, title, status, duration, metadata, channel id; storage keys are NOT exposed).
**Errors:** 404 `VIDEO_NOT_FOUND`.

#### GET /videos/:publicId/stream (SI-03.7) — playback

**Auth:** Public. **Requires** `status = ready`.
**Request header:** optional `Range: bytes=<start>-<end>`.
**Response 206** (with `Range`): `Content-Range: bytes start-end/total`, `Accept-Ranges: bytes`, `Content-Length` = slice, `Content-Type`, body = byte slice.
**Response 200** (no `Range`): full body streamed, `Accept-Ranges: bytes`.
**Errors:** 404 `VIDEO_NOT_FOUND`, 409 `VIDEO_NOT_READY`.

#### GET /videos/:publicId/download (SI-03.7) — download

**Auth:** Public. **Requires** `status = ready`.
**Response 302:** `Location` = presigned GET URL with `Content-Disposition: attachment; filename="<original>"`.
**Errors:** 404 `VIDEO_NOT_FOUND`, 409 `VIDEO_NOT_READY`.

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Ownership | Notes |
|----------|--------|---------------|-----------|-------|
| POST /videos | | ✓ | own channel | Draft pre-registered for the caller's channel |
| POST /videos/:id/complete | | ✓ | must own video | 403 `VIDEO_NOT_OWNED` otherwise |
| GET /videos | | ✓ | own videos only | Lists only the caller's videos |
| GET /videos/:publicId | ✓ | | | Metadata; anonymous-viewing premise |
| GET /videos/:publicId/stream | ✓ | | | Only `ready`; range/`206` |
| GET /videos/:publicId/download | ✓ | | | Only `ready`; presigned redirect |

Read endpoints are `@Public()` because the platform allows anonymous viewing (project plan); write endpoints inherit the global `JwtAuthGuard` and enforce channel ownership in the service.

---

### Error Catalog

Error response format (inherited from Phase 02): `{ statusCode, error, message }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown `:id`/`:publicId` |
| VIDEO_NOT_OWNED | 403 | Video does not belong to the current user | `complete`/owner-scoped op on another channel's video |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | stream/download before `status = ready` |
| INVALID_UPLOAD | 400 | Upload cannot be completed | `complete` on a non-`draft` video, or multipart completion failed |
| CHANNEL_NOT_FOUND | 404 | Channel not found for current user | Caller has no channel (defensive) |

(Plus the inherited `VALIDATION_ERROR` 400 from the global `ValidationExceptionFilter`.)

---

### Events / Messages

**Transport:** BullMQ over Redis (TD-03). Producer = API (`VideoProcessingProducer`); Consumer = `video-worker` (`VideoProcessor`).

| Aspect | Value |
|--------|-------|
| Queue name | `video-processing` |
| Job name | `process-video` |
| Payload | `{ videoId: string }` (small — the worker loads the row) |
| `jobId` | `videoId` (idempotent enqueue — no duplicate active job per video) |
| Retries | `attempts = VIDEO_PROCESSING_ATTEMPTS` (default 3) |
| Backoff | exponential, `delay = VIDEO_PROCESSING_BACKOFF_MS` (default 5000ms) |
| `removeOnComplete` | `true` |
| `removeOnFail` | `false` (failed jobs retained for diagnosis — TD-09) |
| Producer trigger | `POST /videos/:id/complete` after `CompleteMultipartUpload` + `HeadObject` succeed and status → `processing` |
| Consumer success | duration/metadata extracted, thumbnail uploaded → `markReady` → status `ready` |
| Consumer failure | after attempts exhausted → `markError(reason)` → status `error`, job retained |
| Delivery semantics | at-least-once; `process()` is idempotent (no-op when the video is missing or not `processing`) |

**Status state machine:**

```
draft ──(POST /complete: multipart complete + HeadObject ok)──▶ processing
processing ──(worker success: probe + thumbnail + markReady)──▶ ready
processing ──(worker fails all attempts: markError)──────────▶ error
```

Only `ready` videos are streamable/downloadable. `draft` videos with no completion are inert (no job enqueued).

---

## Dependency Map

```
SI-03.1 (infra/config — no deps)
├── SI-03.2 (storage)
│   └── SI-03.3 (entity/migration/module)
│       └── SI-03.4 (queue/producer)
│           └── SI-03.5 (videos service)
│               ├── SI-03.6 (controller: init/complete/list/metadata)
│               │   └── SI-03.7 (stream/download)
│               └── SI-03.8 (worker: ffmpeg + processor + compose)
│                   
SI-03.6 + SI-03.7 + SI-03.8
└── SI-03.9 (full pipeline E2E + DoD + docs)
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9.

## Deliverables

- [ ] Object storage (MinIO) service in `compose.yaml`, S3-compatible, with bucket auto-bootstrap
- [ ] Redis service in `compose.yaml` as the BullMQ broker
- [ ] `video-worker` service in `compose.yaml` (FFmpeg) consuming the processing queue
- [ ] `Video` entity owned by a channel + migration creating the `videos` table with `video_status` enum
- [ ] Presigned multipart upload — 10GB-capable, bytes go direct to storage, never through the API
- [ ] Draft pre-registration of the video at upload init (`status = draft`)
- [ ] `POST /videos/:id/complete` finalizes multipart, verifies via `HeadObject`, flips to `processing`, enqueues the job
- [ ] Automatic processing: ffprobe duration/metadata + ffmpeg thumbnail, status → `ready`
- [ ] Processing-failure path: status → `error` after retries, failed job retained
- [ ] Unique public URL per video (`nanoid` `public_id`, unique, regenerate-on-conflict)
- [ ] Streaming endpoint with HTTP range / `206 Partial Content`
- [ ] Download endpoint via presigned URL with attachment disposition
- [ ] Authorization: write endpoints authenticated + ownership; read endpoints public
- [ ] `storage` and `queue` config namespaces + Joi env validation + `.env.example`
- [ ] Unit + integration (MinIO/Redis/Postgres/FFmpeg real) + E2E tests, all green
- [ ] Definition of Done: `npm test` + `npm run test:e2e` + `npx tsc --noEmit` (code 0) + `npm run lint`
- [ ] `CLAUDE.md` (root + `nestjs-project`) updated with the videos section
