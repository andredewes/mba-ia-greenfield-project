---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-27T00:00:00-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-05-12T12:23:19-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-05-12T13:36:17-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, categorias, visibilidade público/unlisted, fluxo de publicação, painel do canal e página pública (Fase 04). Player UI, página de visualização e sugestões (Fase 05). Interações sociais (Fase 06).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de vídeo (tela de upload, player) é entregue em fases posteriores (Fase 04/05); esta fase é backend-only.

**Sequencing notes:** Depends on Fase 01 (Configuração Base) and Fase 02 (Auth — canal por usuário). Vídeos pertencem a um canal.

**Neighbors (for boundary detection only):** Fase 02 — Cadastro/Login (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Object Storage Client & Bucket/Key Organization | decided | A (AWS SDK v3, single bucket, id-scoped keys) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Large-File (10GB) Upload Strategy | decided | A (Presigned multipart, direct-to-storage) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Background-Processing Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq, bullmq |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Worker Deployment Model | decided | A (Separate worker container, Nest standalone) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video Metadata & Thumbnail Extraction Tooling | decided | A (Direct execFile of ffprobe/ffmpeg) | — (system FFmpeg) |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Public Video URL Identifier | decided | A (nanoid@^3, unique public_id) | nanoid@^3 |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Cross-layer | Streaming Strategy | decided | A (API range-proxy, 206 Partial Content) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Download Strategy | decided | A (Presigned GET, attachment disposition) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle & Processing-Failure Handling | decided | A (draft→processing→ready\|error, BullMQ retries) | — |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Cross-layer | Upload-Completion Trigger | decided | A (client complete endpoint + HeadObject verify) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-10 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-09, phase-03-videos/TD-10 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** AWS SDK v3 — The architecture's stated intent is "S3-compatible, MinIO locally, S3 in production". The AWS SDK v3 makes that swap a pure configuration change (`endpoint` + `forcePathStyle`), and is the only option with first-class presigned multipart support, which TD-02 depends on. Single bucket (`streamtube-videos`) with id-scoped keys: `videos/{videoId}/original`, `thumbnails/{videoId}/thumb.jpg`. Storage keys never leak to clients.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-02

**Recommendation:** Presigned multipart, direct-to-storage — The only option that satisfies the hard constraint (10GB must not flow through the API) while reusing the storage we already run, and it gives part-level resumability for free. The API issues presigned `UploadPart` URLs; the client PUTs parts directly to MinIO/S3; the API completes the multipart upload. The API never touches the payload.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** BullMQ + Redis — The NestJS-native, batteries-included choice for this workload: small job payload, heavy out-of-band processing, retries/backoff, independently scalable worker. Cost is one Redis container. Redis's at-least-once delivery is fine given idempotent processing.

**Libraries:** `@nestjs/bullmq`, `bullmq`

### phase-03-videos/TD-04

**Recommendation:** Separate `video-worker` container (Nest standalone context) — Process isolation keeps heavy FFmpeg work off the API event loop; the worker reuses the same code/DI/config/entities via a dedicated `WorkerModule` and scales independently. FFmpeg lives only in the worker image.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Direct `execFile` of `ffprobe`/`ffmpeg` — Because the binaries are required either way, adding the now-deprecated `fluent-ffmpeg` imports unmaintained risk for ergonomics we do not need. `ffprobe -print_format json` yields clean, parseable metadata; the thumbnail is taken at a small fixed offset (≈1s, clamped to duration). Zero npm processing dependency; trivially mockable.

**Libraries:** — (system `ffmpeg`/`ffprobe` binaries in the worker image)

### phase-03-videos/TD-06

**Recommendation:** `nanoid@^3` (CommonJS) — Short, URL-safe, collision-resistant handles with a vetted RNG. **`nanoid@5` is ESM-only and cannot be `require()`d from the CommonJS NestJS build — pin to `nanoid@^3`** (last CommonJS line). Stored in a unique `public_id` column; regenerate on unique-constraint conflict so a collision never ships.

**Libraries:** `nanoid@^3`

### phase-03-videos/TD-07

**Recommendation:** API range-proxy with `206 Partial Content` — Keeps a single, stable, authorizable public URL and emits correct partial-content semantics while bounding API memory to one range at a time. `GET /videos/:publicId/stream` forwards the client `Range` to `GetObjectCommand` and pipes the slice back with `206`, `Content-Range`, `Accept-Ranges: bytes`. No CDN requirement in this phase.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Presigned `GET` with attachment disposition — Downloads are full-object transfers where API relaying is most expensive; presigning offloads the entire transfer to storage and yields a proper `attachment` filename via `response-content-disposition`. Streaming stays an API proxy (TD-07) because it needs per-range authorization; download does not.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Explicit enum `draft → processing → ready | error` — Matches the plan's lifecycle, gives a single authoritative status column to gate playback, and leans on BullMQ retry/backoff so `error` is only reached after transient failures are exhausted. A failed job is retained for diagnosis. Only `ready` videos are streamable/downloadable. Visibility (`published`/`unlisted`) is deferred to Fase 04.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Client-driven `complete` endpoint with `HeadObject` verification — Aligns exactly with presigned multipart (someone must call `CompleteMultipartUpload` anyway), needs no notification infrastructure, and lets the API verify the object before enqueuing. `POST /videos` creates the draft + initiates multipart + returns presigned part URLs; `POST /videos/:id/complete` finalizes, verifies via `HeadObject`, flips to `processing`, and enqueues the job.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-02 (Auth Library Approach)

**Recommendation (as implemented):** Custom guards with `@nestjs/jwt` only — A global `JwtAuthGuard` (`APP_GUARD`) protects every endpoint by default; `@Public()` opts out; `@CurrentUser()` exposes the `{ sub, email }` payload. Phase 03's video-write endpoints inherit this guard and read the owner from `@CurrentUser()`.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-07 (Error Response Standardization)

**Recommendation (as implemented):** Custom domain exception filter — Errors extend the abstract `DomainException(errorCode, httpStatus, message)`; the global `DomainExceptionFilter` maps them to `{ statusCode, error, message }`. Phase 03 adds video-specific domain exceptions following the same contract.

**Libraries:** —

### phase-02-auth/TD-06 (Request Validation Library)

**Recommendation (as implemented):** class-validator + class-transformer with the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`). Phase 03 DTOs use the same decorators.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-01-configuracao-base/TD-03 (Config Namespacing)

**Recommendation (as implemented):** Namespaced `registerAs` factories — one file per domain in `src/config/`, typed injection via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`. Phase 03 adds `storage.config.ts` and `queue.config.ts` following this pattern, with new keys added to the Joi `env.validation.ts` schema.

**Libraries:** `@nestjs/config@^4.x`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`; new env vars are added to the Joi schema in `src/config/env.validation.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; entities are discovered by the `*.entity.ts` glob; migrations are hand-reviewed raw-SQL files generated via `npm run migration:generate`. _(from phase 01)_
- Docker service names are used as hosts inside containers (`db`, and now `redis`, `minio`) — never `localhost`. _(from phase 01 / root CLAUDE.md)_
- Entities use `@PrimaryGeneratedColumn('uuid')`, snake_case columns, `@CreateDateColumn`/`@UpdateDateColumn`, and FK relations via an explicit `*_id` column + `@JoinColumn`. _(from phase 02)_
- Domain errors extend the abstract `DomainException(errorCode, httpStatus, message)`; the global `DomainExceptionFilter` renders `{ statusCode, error, message }`. New errors are added as subclasses. _(from phase 02)_
- All endpoints are protected by the global `JwtAuthGuard`; public endpoints opt out with `@Public()`; the authenticated payload is read via `@CurrentUser()`. _(from phase 02)_
- Controllers follow REST conventions (plural resource nouns, correct verbs/status codes) and document responses with `@nestjs/swagger` decorators; business logic lives in services, never controllers. _(from phase 02)_
- DTOs use class-validator decorators; the global `ValidationPipe` strips unknown properties and transforms payloads. _(from phase 02)_
- Tests follow the pyramid: `*.spec.ts` (unit, mocked), `*.integration-spec.ts` (real DB/services), `*.e2e-spec.ts` (full HTTP via supertest in `test/`); integration/e2e run with `--runInBand` against the Compose services. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Rationale | Origin |
|------------|--------|-----------|--------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | `next-frontend/` UI surfaces start in a later phase; not reopened here. | phase 02 |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Interface de upload / player de vídeo (`next-frontend/`) | deferred | Esta fase é backend-only; a UI de vídeo é entregue na Fase 04/05. | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type. Phase 03 introduces a new domain module (videos), an object-storage integration, a queue producer, a standalone worker (consumer), and HTTP endpoints for upload-init/complete, streaming, and download. Coverage per the pyramid:

- **Unit (`*.spec.ts`):** services with mocked storage/queue/repository (videos service status transitions, public-id generation/retry, range-header parsing, worker processing logic with a mocked FFmpeg/exec wrapper and storage).
- **Integration (`*.integration-spec.ts`):** real Postgres (video entity constraints, migration apply/revert), real MinIO (storage service put/head/presign/get-range round-trips), real Redis (queue enqueue/consume), worker end-to-end against MinIO + a small fixture video.
- **E2E (`*.e2e-spec.ts`):** full HTTP cycle via supertest — `POST /videos` (draft + presigned parts), `POST /videos/:id/complete` (enqueue + status), `GET /videos/:publicId/stream` (`206` + `Content-Range`), `GET /videos/:publicId/download`, authorization (guard) and ownership checks.

Do not mock what the Compose stack can exercise for real (MinIO, Redis, Postgres). Specific layer coverage by SI is recorded in `progress.md`.
