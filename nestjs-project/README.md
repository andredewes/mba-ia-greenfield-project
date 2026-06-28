# StreamTube Backend

NestJS 11 API for StreamTube. It includes authentication, users, channels, video upload, object storage integration, BullMQ processing, and an FFmpeg worker.

## Services

| Service | Purpose | Local port |
|---------|---------|------------|
| `nestjs-api` | API container and development shell | `3000` |
| `db` | PostgreSQL 17 | `5432` |
| `mailpit` | SMTP capture and email UI | `1025`, `8025` |
| `redis` | BullMQ broker | `6379` |
| `minio` | S3-compatible object storage | `9000`, `9001` |
| `video-worker` | Background FFmpeg processor | none |

## First Run

```bash
cp .env.example .env
docker compose up -d db mailpit redis minio nestjs-api
docker compose exec nestjs-api npm install
docker compose exec nestjs-api npm run migration:run
docker compose exec -d nestjs-api npm run start:dev
docker compose up -d video-worker
```

The API is available at <http://localhost:3000>. MinIO Console is available at <http://localhost:9001> with `minioadmin` / `minioadmin`.

On a clean clone, start `video-worker` only after `npm install`. The worker command uses the bind-mounted `node_modules` directory.

## Regular Startup

```bash
docker compose up -d
docker compose exec -d nestjs-api npm run start:dev
```

Run pending migrations after pulling changes that add database migrations:

```bash
docker compose exec nestjs-api npm run migration:run
```

## Tests

Unit and integration tests use the same Docker database and must run without the worker consuming the queue:

```bash
docker compose stop video-worker
docker compose exec nestjs-api npm test -- --runInBand
```

End-to-end tests include the real video pipeline and require the worker running against a migrated database:

```bash
docker compose up -d video-worker
docker compose exec nestjs-api npm run test:e2e
```

## Quality Checks

```bash
docker compose exec nestjs-api npx tsc --noEmit
docker compose exec nestjs-api npm run lint
```

## Video Pipeline

`POST /videos` creates a draft and returns presigned multipart upload URLs. The client uploads bytes directly to MinIO/S3, then calls `POST /videos/:id/complete`. The API validates the stored object, moves the video to `processing`, and enqueues a BullMQ job. `video-worker` consumes the job, runs `ffprobe`/`ffmpeg`, uploads a thumbnail, and marks the video `ready` or `error`.
