# crazy-games-downloader-2 — HTML5 Game Importer (NestJS)

Production-ready, modular game importer. It accepts an **authorized** game source
URL, detects the engine (confidence scoring), imports only assets the platform is
authorized to redistribute, validates the package, and stores it via a pluggable
backend.

> **Rights & safety first:** imports require `SourcePolicy` allowlisting. The
> importer never bypasses DRM, auth, paywalls, anti-bot or access controls, never
> scrapes/mirrors arbitrary protected content, and never executes imported
> JavaScript on the server.

## Layout

```
src/
  main.ts / app.module.ts
  config/            database.config.ts (TypeORM: postgres via DATABASE_URL,
                     sqlite file otherwise), redis.config.ts
  game-importer/
    core/            types.ts, importer.ts (workflow facade),
                     detector.ts (composite + scoring),
                     downloader.ts (SSRF-safe fetch), extractor.ts (zip guards),
                     validator.ts (package checks), source-policy.ts,
                     ssrf.ts, path-utils.ts
    engines/         engine.interface.ts, unity/*, generic-html5.importer.ts
                     (Phaser / Godot / Construct plug in here later)
    sources/         source.interface.ts (GameSourceAdapter/ResolvedGameSource),
                     source-registry.ts, authorized-source-policy.ts,
                     crazygames/ (adapter, parser, types, fixtures)
    runtime/         runtime-validator.interface.ts, runtime.types.ts,
                     init-signals.ts, local-package-server.ts,
                     playwright-runtime-validator.ts
    queue/           import.queue.ts (BullMQ or in-memory driver),
                     import.worker.ts (pipeline)
    storage/         storage.interface.ts, local.storage.ts,
                     storage.factory.ts (local only — no remote storage in M3)
    entities/        import-job.entity.ts (TypeORM)
    game-imports.controller.ts / game-imports.service.ts
test/
  game-imports.e2e-spec.ts   integration: create, queue, worker, failure,
                             cancel, storage upload
  game-imports-source.e2e-spec.ts  M2.5: CrazyGames fixtures -> adapter ->
                             detection -> unity/brotli/alt-names/completed,
                             non-Unity not forced into Unity
  runtime-validation.e2e-spec.ts  M3: fixture source -> adapter -> unity ->
                             package -> local HTTP -> Playwright success, plus
                             console/page-error, failed-asset, timeout,
                             external-reference cases
scripts/
  validate-real.ts   opt-in real-authorized-source validation (M3)
```

## Quick start

```bash
cp .env.example .env
# edit .env: set SOURCE_ALLOWED_HOSTS to your redistribution partners
npm install
npm run start:dev
```

Default run needs **no Redis/DB server**: SQLite file (`./data/app.sqlite`) +
in-memory queue driver. Set `REDIS_URL` + `QUEUE_DRIVER=bullmq` and
`DATABASE_URL` for production.

## API

| Method | Route | Description |
|---|---|---|
| `POST` | `/game-imports` | `{ "sourceUrl": "https://…" }` → creates job, validates SourcePolicy, enqueues |
| `GET` | `/game-imports/:id` | status, progress, detectedEngine, downloadedFiles, totalFiles, currentStep, error |
| `POST` | `/game-imports/:id/cancel` | cooperative cancel |
| `GET` | `/game-imports/:id/logs` | job log entries |

Import states: `queued → detecting → resolving → downloading → extracting →
validating → uploading → completed` (`failed` / `cancelled` terminal).
(`resolving` also covers the M2.5 source-adapter stage: `source: <name>`.)

## Source adapters (M2.5)

```
Source URL -> Source Adapter -> ResolvedGameSource -> Engine Detector ->
Engine Importer -> Game Package -> Storage
```

- A **source adapter** identifies and resolves assets from an authorized
  platform (platform knowledge lives ONLY in `sources/<platform>/`).
- An **engine importer** packages/normalizes those assets (no source logic).
- `CrazyGamesSourceAdapter`: pure hostname `canHandle()`; `resolve()`
  checks `SourcePolicy` before fetching, uses the SSRF-guarded downloader,
  re-checks policy on every final URL, refuses off-platform redirects and
  access-restricted pages (no bypass of auth/bot-protection/DRM/signed URLs,
  no hidden-API discovery, no hardcoded filenames). Returns the public game
  iframe as `entryUrl` plus script/style `assetUrls` and og metadata.
- Unknown hosts keep the legacy direct-fetch path unchanged.
- Adding a platform: implement `GameSourceAdapter`, register in
  `GameImporterModule` `SOURCE_ADAPTER_COLLECTION`. No engine changes needed.

Normalized package:

```
package/
  manifest.json   # name/engine/entryFile + slug/version/source/assets (M3)
  index.html
  Build/
    game.loader.js  game.framework.js  game.wasm  game.data
```

Failure shape (M3): jobs expose `{ status: "failed", errorCode, error,
diagnostics }` with stable codes (`MISSING_ASSET`, `RUNTIME_TIMEOUT`, …);
diagnostics are secret-redacted at collection time.

## Runtime validation (M3)

```
Source Adapter -> ResolvedGameSource -> Engine Detector -> Engine Importer ->
Package Validator -> Runtime Validator -> Local Storage
```

- `LocalPackageServer` serves **only** the package dir on `127.0.0.1`
  (ephemeral port, correct WASM MIME, no listing, traversal-safe). Never
  `file://`.
- `PlaywrightRuntimeValidator` opens the entry in headless Chromium,
  captures console/page errors and failed requests, polls multi-signal Unity
  init (canvas, loader/framework/wasm/data 200s, explicit flags, init console
  message, zero fatal errors) until `RUNTIME_VALIDATION_TIMEOUT_MS`.
- External requests are recorded as `EXTERNAL_REFERENCE` (optionally
  blocked), never proxied or bypassed.
- Imported games are **untrusted**: they run only in the browser sandbox —
  no Node.js, no `require`/`eval`, no env/DB/Redis/filesystem access.

## Real validation (opt-in, M3)

```bash
REAL_TEST_SOURCE_URL=https://www.crazygames.com/game/<slug> npm run validate:real
```

- Requires explicit authorization to import/redistribute the tested game;
  the host must also satisfy `SOURCE_ALLOWED_HOSTS` + SSRF guards.
- Runs resolve → detect → import → package validation → Playwright, prints a
  JSON report, exits 0/1 (2 = skipped, URL not configured).
- Uploads nothing anywhere; normal CI never runs it (no live dependency).

## Security model

1. **SourcePolicy allowlist** (`SOURCE_ALLOWED_HOSTS`, `ALLOW_ANY_HTTPS=false` in
   prod) enforced *before* any download and re-checked on the post-redirect URL.
2. **SSRF protection** (`core/ssrf.ts`): blocks localhost, loopback, private
   ranges, link-local, cloud metadata hosts/IPs, non-http(s) protocols, embedded
   credentials; DNS-resolves every host and **revalidates every redirect**.
3. **Archive guards**: Zip-Slip/traversal rejection, absolute-path rejection,
   max archive/extracted size, max file count, max compression ratio.
4. **Worker isolation**: per-job timeout (`WORKER_TIMEOUT_MS`), disk cap
   (`WORKER_MAX_DISK_MB`), download caps, cooperative cancellation; no imported
   JS is ever `eval`'d — parsing is static text analysis only.
5. **Serving isolation (operator duty)**: serve stored games from a **separate
   origin** (e.g. `games-cdn.example.com`) with `Content-Security-Policy:
   sandbox`, `X-Content-Type-Options: nosniff`, no cookies/auth on that origin.
   The NestJS app never executes game code.
6. Package paths re-validated before storage; secrets never logged (error
   messages truncated, URLs query-stripped, tokens/cookies redacted).
7. **Runtime isolation (M3)**: the local package server binds loopback only
   and is confined to the package dir; headless Chromium runs game code in a
   separate OS process with no Node.js/env/DB/Redis access; external
   requests are reported (`EXTERNAL_REFERENCE`), never bypassed or proxied.

## Milestones

- **M1 (done)**: core interfaces, ImportJob model, queue (BullMQ + memory),
  SourcePolicy, Unity detector/loader-parser/decompressor, package validator,
  LocalStorage, full unit coverage.
- **M2 (done)**: Unity importer, asset resolver, progress tracking, integration
  tests.
- **M2.5 (done)**: source adapter layer (`GameSourceAdapter`,
  `ResolvedGameSource`, `SourceRegistry`), CrazyGames adapter (Unity, HTML5,
  Brotli, alt-filename, unsupported layouts via local fixtures), adapter-aware
  worker + Unity handoff, unit + fixture-backed e2e coverage.
- **M3 (done)**: structured diagnostics + stable codes, hardened Unity
  loader/asset handling (coded fail-closed errors, http(s)-only), Brotli
  diagnostics, inventory-driven package validation, manifest
  slug/version/source/assets, job `errorCode`/`diagnostics`, local HTTP
  package server, Playwright runtime validator (multi-signal init, console/
  page-error/failed-request capture, timeout, external-request reporting),
  opt-in `npm run validate:real`, fixture-backed runtime e2e. Storage stays
  local — no S3/R2/CDN.
- **M4 (planned)**: `storage.factory.ts` `s3` driver (S3/R2), Playwright
  smoke test on the isolated serving origin.

## Manual configuration required

- `.env`: `SOURCE_ALLOWED_HOSTS` (your authorized partners), `REDIS_URL` +
  `QUEUE_DRIVER=bullmq` for prod, `DATABASE_URL` for Postgres, `STORAGE_*`,
  `RUNTIME_VALIDATION_TIMEOUT_MS` for slower builds,
  `RUNTIME_VALIDATION_SETTLE_MS` for late-loading audio banks,
  `UNITY_STREAMING_ASSETS_*` caps/toggles for dependency discovery
  (see `.env.example`).
- Production: TLS, isolated game-serving origin + sandbox CSP headers, Redis
  persistence, DB backups, secret management (never commit `.env`).
- Adding an engine: implement `GameEngineImporter`, register in
  `GameImporterModule` `ENGINE_COLLECTION`. No other code changes needed.
- Real validation: `REAL_TEST_SOURCE_URL` + allowlisted host + a Chromium
  binary in Playwright's standard browser cache (set
  `PLAYWRIGHT_EXECUTABLE_PATH` to override the path).

## Known limitations (M3)

- Init detection is evidence-based (canvas + asset 200s + flags); a game
  that loads but never paints/flags still reports `RUNTIME_TIMEOUT`.
- Games requiring external services at runtime report `EXTERNAL_REFERENCE`;
  availability of those services is not retried or proxied.
- Single-file/bundled Unity builds (no separate `.loader.js`) are not
  importable — loader discovery requires a loader script reference.
- StreamingAssets dependencies are discovered at import time (bounded
  runtime network observation under the Unity `streamingAssetsUrl` prefix
  plus static `StreamingAssets/...` references, SourcePolicy-gated,
  capped, nested paths preserved under `package/StreamingAssets/`) and
  runtime validation keeps observing past boot (settle window) so late
  bank/asset 404s and FMOD failures report `RUNTIME_ERROR` instead of a
  premature `RUNTIME_OK`.

## Scripts

`npm run build | start | start:dev | lint | typecheck | test | test:e2e | validate:real`
