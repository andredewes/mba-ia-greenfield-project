# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos (Phase 03 — Upload & Processing)

The video pipeline lets a channel upload large files (up to 10GB) directly to object storage, processes them asynchronously, and serves streaming/download. It introduces three infrastructure services in `compose.yaml`: **`minio`** (S3-compatible object storage), **`redis`** (BullMQ broker), and **`video-worker`** (FFmpeg processor).

### Module layout (`src/videos/`)

- `entities/video.entity.ts` — `Video` (belongs to a `Channel`), status enum `draft → processing → ready | error`, `public_id` (unique short URL handle), storage/thumbnail keys, duration, jsonb metadata.
- `videos.service.ts` — business logic: initiate upload (draft + presigned multipart), complete upload (finalize + verify + enqueue), lookups/ownership, streaming/download helpers, and worker-facing `markReady`/`markError`.
- `videos.controller.ts` — REST endpoints (below). `@SkipThrottle()` so playback/reads are not rate-limited.
- `dto/` — `CreateVideoDto`, `CompleteUploadDto`.
- `public-id.util.ts` — `nanoid(12)` URL-safe id (pinned to `nanoid@^3`, CJS).
- `exceptions/video.exceptions.ts` — domain errors (`VIDEO_NOT_FOUND`, `VIDEO_NOT_OWNED`, `VIDEO_NOT_READY`, `INVALID_UPLOAD`, `CHANNEL_NOT_FOUND`).
- `processing/` — `video-processing.constants.ts` (queue/job names + payload), `video-processing.producer.ts` (enqueue), `ffmpeg.service.ts` (`ffprobe`/`ffmpeg` via `execFile`), `video.processor.ts` (BullMQ `@Processor`).

Object storage lives in `src/storage/` (`StorageService` — AWS SDK v3, MinIO via `forcePathStyle`; bucket auto-bootstrap on boot). The worker is a standalone Nest app context in `src/worker/` (`worker.module.ts` + `main.ts`).

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/videos` | Bearer | Initiate upload — creates draft, returns presigned multipart part URLs |
| POST | `/videos/:id/complete` | Bearer (owner) | Finalize multipart, verify, flip to `processing`, enqueue job |
| GET | `/videos` | Bearer | List the caller's videos |
| GET | `/videos/:publicId` | Public | Video metadata |
| GET | `/videos/:publicId/stream` | Public | Range streaming (`206 Partial Content`), only `ready` |
| GET | `/videos/:publicId/download` | Public | `302` to presigned attachment URL, only `ready` |

### Upload handshake (10GB, never through the API)

`POST /videos` → API creates the draft + `CreateMultipartUpload` + presigns each part → client `PUT`s parts **directly to MinIO/S3** → `POST /videos/:id/complete` with the part ETags → API `CompleteMultipartUpload` + `HeadObject` (size) → status `processing` + enqueue `process-video` job. The API never relays the bytes.

### Queue + worker

BullMQ queue `video-processing`, job `process-video` (`{ videoId }`), `jobId = videoId` (idempotent), retries with exponential backoff (defaults 3 / 5000ms), failed jobs retained. The `video-worker` container consumes jobs: downloads the original, `ffprobe` for duration/metadata, `ffmpeg` for a thumbnail frame, uploads the thumbnail, and `markReady` (or `markError` after retries exhausted).

### New environment variables

`S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `UPLOAD_PART_SIZE_BYTES`, `UPLOAD_PRESIGN_EXPIRY_SECONDS`, `DOWNLOAD_PRESIGN_EXPIRY_SECONDS`, `REDIS_HOST`, `REDIS_PORT`, `VIDEO_PROCESSING_ATTEMPTS`, `VIDEO_PROCESSING_BACKOFF_MS` (all defaulted to the Compose service names; see `.env.example`).

### Running

```bash
docker compose up -d                 # starts db, mailpit, redis, minio, nestjs-api, video-worker
# MinIO console: http://localhost:9001 (minioadmin / minioadmin)
```

The worker runs `npm run start:worker` (`ts-node --transpile-only src/worker/main.ts`). When running the unit/integration suite (`npm test`), the `video-worker` must be **stopped** — otherwise it consumes the `video-processing` queue and breaks queue-state integration tests. The end-to-end pipeline test (`npm run test:e2e`) requires the worker **running**. A `test/fixtures/sample.mp4` (a 2s clip) drives the real worker pipeline test.

