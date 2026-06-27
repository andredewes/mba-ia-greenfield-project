# phase-03-videos — Progress

**Status:** in-progress
**SIs:** 3/9 completed

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
- **Status:** not-started
- **Tests:** —
- **Observations:** —

### SI-03.5 — Videos Service: draft creation, completion, and status transitions
- **Status:** not-started
- **Tests:** —
- **Observations:** —

### SI-03.6 — Videos Controller: upload init, complete, metadata, list
- **Status:** not-started
- **Tests:** —
- **Observations:** —

### SI-03.7 — Streaming and Download Endpoints
- **Status:** not-started
- **Tests:** —
- **Observations:** —

### SI-03.8 — Video Worker (standalone process) + FFmpeg processing
- **Status:** not-started
- **Tests:** —
- **Observations:** —

### SI-03.9 — End-to-end pipeline verification, DoD, and AI docs
- **Status:** not-started
- **Tests:** —
- **Observations:** —
