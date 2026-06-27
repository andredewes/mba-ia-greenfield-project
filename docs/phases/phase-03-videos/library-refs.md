---
kind: phase
name: phase-03-videos
purpose: "Pinned external libraries and system binaries introduced by Phase 03, with the exact versions, the APIs the plan relies on, and compatibility notes verified against the published registry metadata (context7 unavailable in this environment — versions confirmed via the npm registry on 2026-06-27)."
---

# phase-03-videos — Library References

All versions below were confirmed against the npm registry on 2026-06-27 and are compatible with the project's runtime (Node 25 in the container, NestJS 11, **CommonJS** module output, TypeScript 5.7).

## Production dependencies (nestjs-project)

### `@aws-sdk/client-s3` — `^3.1075.0`
- **Why:** S3-compatible object-storage client (TD-01). Same code path targets MinIO (dev) and AWS S3 (prod) via `endpoint` + `forcePathStyle`.
- **Key APIs:** `S3Client`, `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, `HeadObjectCommand`, `GetObjectCommand` (with `Range`), `PutObjectCommand`, `DeleteObjectCommand`, `CreateBucketCommand`/`HeadBucketCommand` (bucket bootstrap).
- **Compat:** `engines.node >= 20` (container Node 25 ✓). CommonJS build shipped (`dist-cjs`). For MinIO use `forcePathStyle: true` and a static-credentials provider.

### `@aws-sdk/s3-request-presigner` — `^3.1075.0`
- **Why:** Generates presigned URLs for direct-to-storage upload parts (TD-02) and presigned download (TD-08). Kept version-aligned with `client-s3`.
- **Key APIs:** `getSignedUrl(client, command, { expiresIn })` — used to presign `UploadPartCommand` and `GetObjectCommand` (download with `ResponseContentDisposition`).
- **Compat:** `engines.node >= 20` ✓. Must share the same `@aws-sdk` major/minor as `client-s3`.

### `@nestjs/bullmq` — `^11.0.4`
- **Why:** First-party NestJS integration for the BullMQ queue (TD-03). Provides `BullModule.forRoot`/`registerQueue`, `@Processor`, `@OnWorkerEvent`, `InjectQueue`.
- **Key APIs:** `BullModule.forRootAsync` (Redis connection), `BullModule.registerQueue({ name })`, `@InjectQueue()`, `WorkerHost` / `@Processor(name)`.
- **Compat:** peer `@nestjs/common`/`@nestjs/core` `^10 || ^11` (project is 11 ✓); peer `bullmq` `^3 || ^4 || ^5`.

### `bullmq` — `^5.79.2`
- **Why:** The queue engine itself (Redis-backed jobs, retries/backoff, failed-set retention) — TD-03/TD-09.
- **Key APIs:** `Queue#add(name, data, opts)` with `attempts` + `backoff`; `Worker`/`WorkerHost#process(job)`; job `failedReason`, retained failed jobs.
- **Compat:** `engines.node >= 12` ✓. Bundles `ioredis@5` transitively (no separate Redis client dependency needed). At-least-once delivery → processing handler is idempotent by design.

### `nanoid` — `^3.3.15`  ⚠ version-pinned to v3
- **Why:** Short, URL-safe unique public video identifier (TD-06), stored in a unique `public_id` column.
- **Key APIs:** `nanoid(size?)` — default 21-char URL-safe id; phase uses a 12-char id for compact watch URLs.
- **Compat (critical):** **`nanoid@5` is ESM-only** (`"exports"` map, no CommonJS entry) and CANNOT be `require()`d from this project's CommonJS NestJS build. **Must stay on `nanoid@^3`** (`3.3.15` is the latest CommonJS release). Do not let a dependency bump pull v4/v5.

## System binaries (video-worker image only)

### FFmpeg suite — `ffmpeg` + `ffprobe` (Debian `ffmpeg` apt package)
- **Why:** Metadata extraction and thumbnail generation (TD-05), invoked directly via `child_process.execFile` (no npm wrapper — `fluent-ffmpeg` is deprecated).
- **Key invocations:**
  - Metadata: `ffprobe -v quiet -print_format json -show_format -show_streams <input>` → parse JSON (`format.duration`, `streams[].codec_name`, `width`, `height`, `bit_rate`).
  - Thumbnail: `ffmpeg -y -ss <offset> -i <input> -frames:v 1 -q:v 2 <output.jpg>` (offset ≈ min(1s, duration/2)).
- **Compat:** Installed only in the `video-worker` image (keeps the API image lean). The worker reads the original from storage to a temp file, runs the binaries, and uploads the thumbnail back.

## Infrastructure images (compose.yaml)

| Service | Image | Pin | Role |
|---------|-------|-----|------|
| `minio` | `minio/minio` | `RELEASE.2025-04-08T15-41-24Z`-class (latest stable `:latest` acceptable for dev) | S3-compatible object storage (TD-01) |
| `redis` | `redis` | `7-alpine` | BullMQ broker (TD-03) |
| `video-worker` | built from `Dockerfile.worker` (node + ffmpeg) | — | BullMQ consumer (TD-04/05) |

> Pinning note: for local dev the MinIO and Redis images use stable major tags (`redis:7-alpine`, `minio/minio:latest`); production would pin exact digests. This is a dev-compose decision consistent with the existing `postgres:17` / `axllent/mailpit` pins.

## Install command (SI-03.1)

```bash
docker compose exec nestjs-api npm install \
  @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3 \
  @nestjs/bullmq@^11 bullmq@^5 nanoid@^3
```

No new `@types/*` packages are required: all five ship their own TypeScript definitions, and the FFmpeg integration uses Node's built-in `child_process` types.
