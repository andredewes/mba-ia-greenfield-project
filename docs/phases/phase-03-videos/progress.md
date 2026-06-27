# phase-03-videos — Progress

**Status:** in-progress
**SIs:** 7/9 completed

### SI-03.1 — Dependencies, Config Namespaces, Env, and Infra (Redis + MinIO)
- **Status:** completed
- **Tests:** no tests (infra/config) — stack boots with redis (healthy) + minio; deps at expected versions
- **Observations:** MinIO image lacks curl/mc for a healthcheck → used `depends_on: service_started` for minio and made `StorageService.ensureBucket()` retry at boot. `.env` is gitignored; created from `.env.example`.

### SI-03.2 — Storage Module (S3/MinIO wrapper)
- **Status:** completed
- **Tests:** 14/14 passing (storage.service.spec.ts unit, storage.service.integration-spec.ts real MinIO)
- **Observations:** AWS SDK v3 with `forcePathStyle` for MinIO. Multipart round-trip, ranged 206 reads, presigned download verified against real MinIO.

### SI-03.3 — Video Entity, Migration, and Videos Module skeleton
- **Status:** completed
- **Tests:** 32/32 passing (with channels neighbors): video.entity.integration-spec, videos.module.spec, migrations.integration-spec
- **Observations:** Generated `CreateVideos` migration (enum, unique public_id, FK→channels, bigint, jsonb). Fixed a pre-existing fragility in migrations.integration-spec.ts: concurrent `Promise.all` DROPs deadlock when tables exist → changed to sequential drops + drop leftover enum types. All integration tests declare the SAME full entity set `[User, Channel, RefreshToken, VerificationToken, Video]` so synchronize stays a no-op; updated `cleanAllTables` to delete videos first (FK order).

### SI-03.4 — Processing Queue (BullMQ) and Job Contract
- **Status:** completed
- **Tests:** 4/4 passing (video-processing.producer.spec unit, video-processing.producer.integration-spec real Redis, videos.module.spec)
- **Observations:** BullModule.forRootAsync in AppModule; registerQueue('video-processing') in VideosModule. Producer uses jobId=videoId for idempotent enqueue, attempts/backoff from queue config, removeOnFail:false to retain failed jobs.

### SI-03.5 — Videos Service: draft creation, completion, and status transitions
- **Status:** completed
- **Tests:** 17/17 passing (public-id.util.spec, videos.service.spec unit, videos.service.integration-spec real MinIO+Postgres+Redis)
- **Observations:** Added ChannelsService.findByUserId (resolves caller channel). public_id via nanoid(12) with regenerate-on-unique-conflict (PG 23505 on public_id). completeUpload aborts multipart + throws InvalidUploadException on failure; size_bytes from HeadObject; enqueues after flip to processing.

### SI-03.6 — Videos Controller: upload init, complete, metadata, list
- **Status:** completed
- **Tests:** covered by videos.e2e-spec (init 201/401/400, complete 202/403, list owner-scoped, metadata 200/404)
- **Observations:** Controller delegates to VideosService; storage keys never exposed in the response mapper. CurrentUser().sub is the userId.

### SI-03.7 — Streaming and Download Endpoints
- **Status:** completed
- **Tests:** covered by videos.e2e-spec (stream 206 + Content-Range, stream 200 no-range, download 302 presigned attachment, 409 when not ready) — 10/10 e2e green
- **Observations:** Range/storage access encapsulated in VideosService.getPlaybackStream/getDownloadUrl so the controller stays thin; @Res() used to pipe the storage stream; DomainExceptionFilter still maps service exceptions thrown before the response is written.

### SI-03.8 — Video Worker (standalone process) + FFmpeg processing
- **Status:** not-started
- **Tests:** —
- **Observations:** —

### SI-03.9 — End-to-end pipeline verification, DoD, and AI docs
- **Status:** not-started
- **Tests:** —
- **Observations:** —
