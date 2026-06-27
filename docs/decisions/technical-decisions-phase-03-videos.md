---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-27
scope_description: "Backend foundation for large-video upload and processing: object storage access, 10GB upload strategy, background-processing queue, worker deployment model, FFmpeg metadata/thumbnail extraction, unique public URL identifier, range streaming, download, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (entity, upload-init/complete endpoints, streaming, download), the object-storage integration (MinIO/S3), the processing queue (producer side), and the standalone video worker (consumer side, FFmpeg).
- `next-frontend/` — Out of scope for this phase. The video UI (upload screen, player page) is delivered in later phases (Fase 04/05). No open decision in this document.

_New infrastructure introduced by this phase (all via Docker Compose):_ object storage (MinIO), a queue broker (Redis), and a separate video-worker container with FFmpeg.

---

## TD-01: Object Storage Client & Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage backend itself is **not** an open choice — the project architecture (`docs/diagrams/software-arch.mermaid`, root `CLAUDE.md`) already mandates **S3-compatible object storage**, run locally as **MinIO** in Docker and swappable for AWS S3 in production. What this TD decides is *how* the backend talks to it (which client library) and *how objects are laid out* (buckets and key naming), since that contract is shared by the API (presign, stream, download), the worker (read original, write thumbnail), and the migration/entity (stored keys).

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Official AWS modular SDK. Same code path works against MinIO (custom `endpoint`, `forcePathStyle: true`) and real S3 (drop the endpoint). Presigning via the dedicated `s3-request-presigner` package; streaming via `GetObjectCommand` with a `Range`.
- **Pros:** Canonical, first-party, actively maintained. `forcePathStyle` + custom `endpoint` is the documented MinIO recipe — zero divergence between dev (MinIO) and prod (S3). Modular tree-shakeable packages. Native presigned-URL and multipart-upload support (needed for TD-02). TypeScript types shipped.
- **Cons:** Large transitive dependency graph (the S3 client pulls many `@aws-sdk/*` and `@smithy/*` packages). API is verbose (command objects).

### Option B: MinIO JS client (`minio`)
- MinIO's own SDK. Simpler ergonomics for MinIO specifically.
- **Pros:** Smaller surface, simple method names (`presignedPutObject`, `getPartialObject`).
- **Cons:** Couples the codebase to the MinIO client even though production targets generic S3. Multipart/presigned-POST ergonomics are less aligned with S3 semantics. The architecture explicitly frames storage as "S3 (compatible)" — using the vendor-neutral AWS SDK keeps the prod swap a config change, not a code change.

**Recommendation:** **Option A (AWS SDK v3)** — The architecture's stated intent is "S3-compatible, MinIO locally, S3 in production". The AWS SDK v3 makes that swap a pure configuration change (`endpoint` + `forcePathStyle`), which is exactly the cross-component property we want. It is the only option with first-class presigned multipart support, which TD-02 depends on. The heavier dependency graph is an accepted, one-time cost.

**Bucket/Key organization (decided):** a single bucket (default `streamtube-videos`, configurable via env) with deterministic, video-id-scoped keys:
- Original upload: `videos/{videoId}/original` (the raw uploaded object).
- Generated thumbnail: `thumbnails/{videoId}/thumb.jpg`.

Rationale: id-scoped prefixes guarantee no cross-video key collision, make per-video cleanup a single prefix delete, and keep the entity columns (`storage_key`, `thumbnail_key`) opaque and stable. The public-facing identifier is **not** the storage key (see TD-06) — storage keys never leak to clients.

**Decision:** A (AWS SDK v3, single bucket, id-scoped keys)

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

---

## TD-02: Large-File (10GB) Upload Strategy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB upload must not pass through the NestJS API process — buffering or even streaming 10GB through the Node event loop pins memory/CPU and blocks the API (the explicit "reprova automática" in the assignment). The decision is the handshake by which the client gets the bytes into object storage without the API relaying them.

**Options:**

### Option A: Presigned URLs — direct-to-storage upload (single PUT for small, multipart for large)
- The API issues short-lived presigned URLs; the client uploads the bytes **directly to MinIO/S3**. For 10GB, S3's hard 5GB single-PUT limit forces **multipart upload**: the API calls `CreateMultipartUpload`, presigns each `UploadPart` URL, the client PUTs each part directly to storage, then the API `CompleteMultipartUpload`. The API never touches the payload.
- **Pros:** The 10GB never enters the API process — constant API memory regardless of file size. Multipart enables parallelism and **resumability** (retry a single failed part, addressing the plan's "retomar em caso de falha"). Standard, documented S3 pattern. Works identically on MinIO and S3.
- **Cons:** More endpoints and a multi-step handshake (initiate → presign parts → complete). The client must orchestrate part uploads. Presigned-URL expiry must be tuned for slow 10GB uploads.

### Option B: Streaming through the API (busboy / streamed `PutObject`)
- The client uploads to the API, which pipes the request stream straight into `PutObject`.
- **Pros:** Single endpoint; client just POSTs a file. API can enforce auth/validation inline.
- **Cons:** Every byte still traverses the API process and its network hop twice (client→API→storage). 10GB ties up an API connection/worker for the whole transfer; concurrent uploads exhaust the API. No native resumability. This is precisely the "passar o arquivo pela API" anti-pattern the assignment forbids.

### Option C: tus resumable-upload protocol (`@tus/server`)
- Resumable-upload protocol with a tus server (in the API or a sidecar) writing to storage.
- **Pros:** Best-in-class resumability and pause/resume UX; chunked.
- **Cons:** Introduces a whole protocol + server component and a tus-capable client. With the tus server in-process, bytes still flow through the API unless paired with a storage backend; the operational weight is high for this phase. Presigned multipart already delivers the core non-functional requirement (API never relays bytes) with far less new surface.

**Recommendation:** **Option A (presigned multipart, direct-to-storage)** — It is the only option that satisfies the hard constraint (10GB must not flow through the API) while reusing the storage we already run, and it gives part-level resumability for free. tus (C) solves the same problem with much more machinery; streaming (B) violates the constraint. The handshake complexity is contained in a small set of endpoints (TD-10 covers the completion/trigger half).

**Decision:** A (Presigned multipart upload, direct-to-storage)

**Libraries:** (covered by TD-01 — no additional library)

---

## TD-03: Background-Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video processing (metadata extraction, thumbnail generation) is heavy and must run off the request path, in a separate worker, with retries and failure visibility. The project plan leaves the queue technology explicitly **"TBD"** — this is the headline stack decision of the phase. The job payload is small (a video id); the work is CPU/IO-heavy and lives in the worker (TD-04).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq` + `bullmq`)
- Redis-backed job queue with a first-party NestJS integration. Producers enqueue via `Queue`; the worker consumes via a `Worker`/`@Processor`. Built-in retries with backoff, delayed jobs, concurrency, events, and failed-job retention.
- **Pros:** De-facto standard for Node background jobs; first-party `@nestjs/bullmq` module (decorators `@Processor`/`@OnWorkerEvent`, `BullModule.registerQueue`). Robust retry/backoff, concurrency, and dead-letter (failed set) semantics out of the box — directly serving the status lifecycle (TD-09). One new container (Redis). Excellent docs. Clean producer/consumer split maps onto the API/worker split (TD-04).
- **Cons:** Adds Redis as new infrastructure. Redis is an at-least-once broker — handlers must be idempotent (acceptable; processing is naturally idempotent here).

### Option B: pg-boss (PostgreSQL-backed queue)
- Job queue built on the existing PostgreSQL (`SKIP LOCKED`).
- **Pros:** No new infrastructure — reuses Postgres. Transactional enqueue alongside DB writes.
- **Cons:** No first-party NestJS module (manual wiring). Postgres-as-queue couples job throughput to the primary DB and competes for connections/IO with application queries. Smaller ecosystem; fewer batteries (concurrency, rate limiting) than BullMQ. For a video pipeline expected to scale workers independently, a dedicated broker is a better fit.

### Option C: RabbitMQ via `@nestjs/microservices`
- AMQP broker with the Nest microservices transport.
- **Pros:** Powerful routing, mature broker, native NestJS transport.
- **Cons:** Heaviest new infrastructure (broker + management). The microservices transport is oriented to message patterns/RPC, not job-queue ergonomics (retries/backoff/delayed jobs need extra work). Overkill for a single-purpose processing queue at this stage.

**Recommendation:** **Option A (BullMQ + Redis)** — It is the NestJS-native, batteries-included choice for exactly this workload: a small job payload, heavy out-of-band processing, retries/backoff, and an independently scalable worker. The cost is one Redis container, which is light and also reusable later (rate limiting, caching). pg-boss saves a container but couples processing load to the primary database and lacks the first-party integration; RabbitMQ is disproportionate. Redis's at-least-once delivery is fine given idempotent processing.

**Decision:** A (BullMQ + Redis)

**Libraries:** `@nestjs/bullmq`, `bullmq` (Redis client `ioredis` is transitive via `bullmq`)

---

## TD-04: Worker Deployment Model

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** FFmpeg processing must run outside the API (CPU-bound, needs the `ffmpeg`/`ffprobe` binaries). The decision is *where* the BullMQ consumer runs and how it is packaged.

**Options:**

### Option A: Separate worker container running a Nest standalone application context
- A second entrypoint (`src/worker/main.ts`) boots the same NestJS codebase via `NestFactory.createApplicationContext(WorkerModule)` — no HTTP server. The `WorkerModule` registers the BullMQ `@Processor` plus the storage and DB providers it needs. A dedicated Compose service `video-worker` builds from a worker image that includes FFmpeg and runs this entrypoint.
- **Pros:** Clean process isolation — heavy FFmpeg work cannot stall the API event loop. Reuses the same code, DI, config, entities, and storage service (DRY). The worker scales independently (more replicas = more throughput). FFmpeg lives only in the worker image, keeping the API image lean. Maps cleanly onto BullMQ producer (API) / consumer (worker).
- **Cons:** A second Docker service and a second build target (worker Dockerfile with FFmpeg). Slightly more Compose surface.

### Option B: In-API processor (same process consumes the queue)
- Register the `@Processor` inside the API process; no separate container.
- **Pros:** No new container; simplest Compose.
- **Cons:** FFmpeg CPU work runs in the API process — directly contends with request handling and can block/slow the API (the exact thing the queue exists to avoid). FFmpeg must be installed in the API image (bloat). No independent scaling. Defeats the purpose of asynchronous processing.

**Recommendation:** **Option A (separate worker container, Nest standalone context)** — Process isolation is the whole point of moving processing off the request path; an in-API processor reintroduces the coupling the queue is meant to remove and forces FFmpeg into the API image. The extra Compose service is a small, standard cost. The worker reuses the existing modules via a dedicated `WorkerModule`, so there is no logic duplication.

**Decision:** A (Separate `video-worker` container, Nest standalone application context)

**Libraries:** (none beyond TD-03)

---

## TD-05: Video Metadata & Thumbnail Extraction Tooling

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must read the uploaded video, extract duration and basic metadata (codec, width/height, bitrate, container format), and capture a single frame as a JPEG thumbnail. The industry-standard tooling is the FFmpeg suite (`ffprobe` for metadata, `ffmpeg` for the frame grab). The decision is how the Node worker drives those binaries.

**Options:**

### Option A: Invoke `ffprobe`/`ffmpeg` binaries directly via `child_process.execFile`
- The worker shells out to `ffprobe -v quiet -print_format json -show_format -show_streams <input>` (parse JSON for duration/metadata) and `ffmpeg -ss <t> -i <input> -frames:v 1 -q:v 2 <out.jpg>` (thumbnail). The binaries are installed in the worker image.
- **Pros:** **Zero npm runtime dependency** for processing — only the system binaries (already in the worker image). Full control over flags; `ffprobe -print_format json` returns clean, typed-parseable output. No deprecated/abandoned package in the dependency tree. Easy to unit-test by mocking the exec wrapper.
- **Cons:** Manual argument construction and output parsing (a thin, well-contained helper). No fluent abstraction.

### Option B: `fluent-ffmpeg` wrapper
- The popular fluent JS API over FFmpeg (`ffmpeg(input).screenshots(...)`, `ffmpeg.ffprobe(...)`).
- **Pros:** Ergonomic chained API; widely used historically; `ffprobe` helper returns parsed metadata.
- **Cons:** **The package is deprecated** on npm ("Package no longer supported") as of 2.1.3 — it still works but receives no maintenance, which is a real long-term/code-quality liability. It also still requires the same system binaries underneath, so it adds an unmaintained layer over what `execFile` does directly.

**Recommendation:** **Option A (direct `execFile` of `ffprobe`/`ffmpeg`)** — Because the binaries are required either way, the only question is whether to add a layer on top. `fluent-ffmpeg` is now deprecated/unmaintained, so adding it imports risk for ergonomics we do not need; `ffprobe -print_format json` already yields clean, parseable metadata. Direct invocation keeps the processing dependency surface at zero npm packages and is trivially mockable for unit tests. The thumbnail is taken at a small fixed offset (e.g. 1s, clamped to duration) to avoid black opening frames.

**Decision:** A (Direct `execFile` of `ffprobe`/`ffmpeg`; FFmpeg installed in the worker image)

**Libraries:** (none — system `ffmpeg`/`ffprobe` binaries in the worker image; no npm package)

---

## TD-06: Unique Public Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, URL-safe, public identifier that is unguessable-ish and never collides — used as the public-facing handle in streaming/download/watch URLs. It is distinct from the internal UUID primary key (which stays internal) and from the storage key (which never leaks).

**Options:**

### Option A: `nanoid` (fixed v3, CommonJS)
- `nanoid` generates compact URL-safe random IDs (e.g. 11–12 chars). Stored in a unique column; on the astronomically rare collision, the unique constraint rejects and we regenerate.
- **Pros:** Tiny, fast, cryptographically strong RNG, URL-safe alphabet by default. Short, clean public URLs. Battle-tested.
- **Cons:** **Version trap:** `nanoid@5` is **ESM-only** and cannot be `require()`d from the project's CommonJS NestJS build — it must be pinned to **`nanoid@^3`** (the last CommonJS line). This is a genuine cross-component compatibility constraint worth recording, not an implementation detail.

### Option B: UUID v4 as the public id
- Reuse a UUID for the public handle.
- **Pros:** No new dependency (Postgres/`crypto` can generate it).
- **Cons:** 36 chars with hyphens — long, ugly public URLs. Larger than necessary for a watch URL. The platform wants short handles (project plan: "URL curta e única").

### Option C: Hand-rolled base62 over `crypto.randomBytes`
- A ~10-line helper mapping random bytes to a base62 alphabet.
- **Pros:** No dependency; full control of length/alphabet; CJS-safe.
- **Cons:** Reinvents a solved problem; must be carefully tested for bias/length. nanoid v3 already provides this, vetted.

**Recommendation:** **Option A (`nanoid@^3`)** — Short, URL-safe, collision-resistant handles with a vetted RNG, at the cost of one tiny dependency. The **ESM/CJS pin to v3 is mandatory** and is captured here precisely because it is the kind of cross-cutting constraint that silently breaks a CommonJS build if missed. UUID (B) yields ugly long URLs against the plan's "short URL" intent; a hand-rolled generator (C) adds risk for no benefit over nanoid v3. A unique DB column plus regenerate-on-conflict guarantees no collision ever ships.

**Decision:** A (`nanoid@^3`, stored in a unique `public_id` column, regenerate on unique-constraint conflict)

**Libraries:** `nanoid@^3`

---

## TD-07: Streaming Strategy

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** Playback must start without downloading the whole file — i.e. HTTP **Range** requests answered with **`206 Partial Content`** so a `<video>` element can seek and buffer progressively. The decision is who serves those ranges.

**Options:**

### Option A: API range-proxy — stream byte ranges from storage through a thin endpoint
- `GET /videos/:publicId/stream` reads the client's `Range` header, issues `GetObjectCommand` to storage with the same `Range`, and pipes the storage body back with `206`, `Content-Range`, `Accept-Ranges: bytes`, and `Content-Length` set to the slice. Only the requested slice flows (typically a few MB), not the whole file.
- **Pros:** Full control: the endpoint enforces authorization/visibility, hides storage keys, and emits correct `206`/`Content-Range` semantics. Works identically on MinIO and S3. The proxied data is bounded to the requested range, so memory stays small even for a 10GB asset. Single stable public URL (uses `publicId`).
- **Cons:** Playback bytes traverse the API (bounded per-range). For very high scale a CDN would be added later — out of scope now.

### Option B: Redirect to a presigned storage URL and let the client range-request storage directly
- The endpoint 302-redirects to a short-lived presigned `GetObject` URL; the browser does range requests straight against storage.
- **Pros:** Playback bytes bypass the API entirely.
- **Cons:** Exposes a direct (if temporary) storage URL; harder to enforce per-request authorization and unlisted/visibility rules (a future phase). Presigned-URL expiry vs. long viewing sessions needs handling. Range/seek semantics depend on the storage's presigned-GET behavior. Couples the public contract to storage URLs rather than a stable API route.

**Recommendation:** **Option A (API range-proxy with `206`)** — It keeps a single, stable, authorizable public URL and emits correct partial-content semantics while bounding API memory to one range at a time. Phase 03 has no CDN requirement; when scale demands it, a CDN/redirect can be layered on without changing the public contract. Redirect-to-presigned (B) leaks storage URLs and complicates the authorization/visibility rules that later phases attach to playback.

**Decision:** A (API range-proxy, `206 Partial Content` from storage)

**Libraries:** (covered by TD-01)

---

## TD-08: Download Strategy

**Scope:** Backend

**Capability:** Download do vídeo pelo usuário

**Context:** Users can download the full original video file. Unlike streaming (bounded ranges, must be authorizable per request), a download is a one-shot full-object transfer where offloading from the API is most valuable.

**Options:**

### Option A: Presigned `GET` URL with attachment disposition
- `GET /videos/:publicId/download` returns (or 302-redirects to) a short-lived presigned `GetObject` URL carrying `response-content-disposition: attachment; filename="..."`. The client pulls the full file **directly from storage**.
- **Pros:** The full (up to 10GB) transfer never traverses the API — no API memory/connection cost for big downloads. `Content-Disposition: attachment` forces a download with a friendly filename. Trivial to implement on top of the presigner already chosen in TD-01.
- **Cons:** Briefly exposes a time-limited storage URL (acceptable; expiry kept short).

### Option B: API proxy the full object
- Pipe the entire `GetObject` body through the API to the client.
- **Pros:** Storage URL never exposed; one consistent code path with streaming.
- **Cons:** A full 10GB download ties up an API connection for the whole transfer and re-introduces the relay cost the upload design (TD-02) deliberately avoids. Poor fit for large files at any concurrency.

**Recommendation:** **Option A (presigned `GET`, attachment disposition)** — Downloads are full-object transfers where API relaying is most expensive; presigning offloads the entire transfer to storage and yields a proper `attachment` filename, consistent with the direct-to-storage philosophy established for upload. Streaming stays an API proxy (TD-07) because it needs per-range authorization and stable URLs; download does not, so the cheaper presigned path wins.

**Decision:** A (Presigned `GET` URL with `response-content-disposition: attachment`)

**Libraries:** (covered by TD-01)

---

## TD-09: Video Status Lifecycle & Processing-Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload

**Context:** A video row exists before its bytes do (pre-registered as a draft when the upload starts) and moves through processing to a terminal state. The status enum is a cross-component contract: the entity/migration define it, the API writes the early transitions, and the worker writes the terminal transitions. The decision is the exact state set, the transitions, and what happens on processing failure.

**Options:**

### Option A: `draft → processing → ready | error`, with BullMQ retries before `error`
- **draft:** row created at upload-init (TD-10), before/while bytes are uploaded. **processing:** set when the client confirms upload completion and the processing job is enqueued. **ready:** worker succeeded — duration/metadata persisted, thumbnail stored. **error:** worker failed after BullMQ exhausts its retry/backoff attempts (failed jobs retained for inspection). Streaming/download are only served for `ready` videos.
- **Pros:** Minimal, intuitive lifecycle that maps 1:1 onto the plan's wording ("rascunho → processando → pronto/erro"). BullMQ's built-in retry/backoff absorbs transient FFmpeg/storage hiccups before declaring `error`. Terminal `error` is observable (row + retained failed job) and re-drivable. Clear gate for what is publicly playable.
- **Cons:** Does not (yet) model `published` vs `unlisted` visibility — but that is explicitly Fase 04 scope, not this phase.

### Option B: Boolean flags (`is_processed`, `has_error`)
- Two booleans instead of an enum.
- **Pros:** No enum type.
- **Cons:** Representable illegal states (`is_processed && has_error`), no single source of truth, awkward to gate streaming. An explicit enum is clearer and matches the existing project style (the `verification_tokens.type` enum precedent).

**Recommendation:** **Option A (explicit enum `draft → processing → ready | error`)** — It matches the plan's exact lifecycle, gives a single authoritative status column to gate playback, and leans on BullMQ's retry/backoff so `error` is only reached after transient failures are exhausted. A failed job stays in the queue's failed set for diagnosis and manual re-drive. Boolean flags (B) admit contradictory states and obscure the gate. Visibility (`published`/`unlisted`) is intentionally deferred to Fase 04.

**Decision:** A (`draft → processing → ready | error` enum; BullMQ retry+backoff; failure → `error` after retries exhausted; only `ready` is streamable/downloadable)

**Libraries:** (none beyond TD-03)

---

## TD-10: Upload-Completion Trigger (how processing starts)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** With direct-to-storage upload (TD-02), the API does **not** see the bytes arrive, so it needs an explicit signal that the upload finished in order to (a) complete the multipart upload, (b) flip status to `processing`, and (c) enqueue the processing job. The decision is the mechanism for that signal.

**Options:**

### Option A: Client-driven completion endpoint + storage verification
- Three-step API contract: **(1) init** (`POST /videos`) — create the draft row (status `draft`, `public_id` assigned), `CreateMultipartUpload`, return the `videoId`, `uploadId`, and presigned part URLs. **(2)** client uploads parts directly to storage. **(3) complete** (`POST /videos/:id/complete` with the part ETags) — the API calls `CompleteMultipartUpload`, issues a `HeadObject` to verify the object exists and capture its size, flips status to `processing`, and enqueues the BullMQ job. The worker then processes and flips to `ready`/`error`.
- **Pros:** No extra infrastructure — the client already knows when its upload finished. `HeadObject` verification guards against enqueuing for a missing/partial object. Deterministic, easy to test end-to-end. The completion call is the natural place to require the multipart ETags. Fits the presigned-multipart design exactly.
- **Cons:** Relies on the client to call complete (a never-completed upload simply stays `draft` — acceptable; such drafts can be reaped later/out of scope).

### Option B: S3/MinIO bucket event notifications → webhook
- Configure MinIO to POST a bucket notification on object creation; an API webhook flips status and enqueues.
- **Pros:** No client "complete" call; storage is the source of truth for completion.
- **Cons:** Requires configuring MinIO event notifications (extra infra/config that diverges from plain S3 setups), a public webhook endpoint, and event-to-video correlation. For multipart, the completion still must be triggered by someone calling `CompleteMultipartUpload` — notifications fire only **after** completion, so this does not remove the need for a completion step; it only moves the enqueue trigger. Net added complexity for no gain here.

**Recommendation:** **Option A (client-driven `complete` endpoint with `HeadObject` verification)** — It aligns exactly with presigned multipart (someone must call `CompleteMultipartUpload` anyway), needs no notification infrastructure, and lets the API verify the object before enqueuing. The init step is where the draft pre-registration (a required capability) naturally happens. Bucket notifications (B) add a webhook and MinIO-specific config without removing the completion step that multipart inherently requires.

**Decision:** A (init `POST /videos` creates draft + multipart + presigned parts; `POST /videos/:id/complete` finalizes, verifies via `HeadObject`, flips to `processing`, enqueues job)

**Libraries:** (covered by TD-01 and TD-03)

---

## Decision Summary

| Ref | Topic | Decision | New libs/infra |
|-----|-------|----------|----------------|
| TD-01 | Object storage client & layout | AWS SDK v3, single bucket, id-scoped keys | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`; MinIO container |
| TD-02 | 10GB upload strategy | Presigned multipart, direct-to-storage | — |
| TD-03 | Queue technology | BullMQ + Redis | `@nestjs/bullmq`, `bullmq`; Redis container |
| TD-04 | Worker deployment | Separate `video-worker` container (Nest standalone) | worker image w/ FFmpeg |
| TD-05 | Metadata & thumbnail | Direct `execFile` of `ffprobe`/`ffmpeg` | FFmpeg binaries (no npm) |
| TD-06 | Unique public URL id | `nanoid@^3` (CJS), unique `public_id` | `nanoid@^3` |
| TD-07 | Streaming | API range-proxy, `206 Partial Content` | — |
| TD-08 | Download | Presigned `GET`, attachment disposition | — |
| TD-09 | Status lifecycle | `draft → processing → ready \| error`, BullMQ retries | — |
| TD-10 | Upload-completion trigger | Client `complete` endpoint + `HeadObject` verify | — |
