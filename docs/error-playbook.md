# Error Playbook — downloaded-game console/runtime failures

> **Triage rule: check this file FIRST.** Before investigating any new
> console/runtime failure, search the entries below for the symptom. If it
> matches a solved entry, apply the documented fix directly — no discovery
> phase. Only undocumented symptoms go through investigation, and every
> solved investigation MUST add (or extend) an entry here.

Entry format for every record:

- **ID** — stable tag, e.g. `UNITY-SA-001`.
- **Status** — `solved` (fix merged, covered by tests) or `open` (known,
  no automatic fix yet).
- **Symptoms** — exact console/network signals to match on.
- **Root cause** — one or two sentences.
- **Fix** — what was changed (files) or what to do.
- **Verify** — how to confirm the fix.
- **First seen** — game + date, so patterns across games stay visible.

---

## UNITY-SA-001 — FMOD bank load fails with StreamingAssets 404s

- **Status:** solved
- **Symptoms:** Unity boots, then `GET /StreamingAssets/Master.bank → 404`,
  `GET /StreamingAssets/Master.strings.bank → 404`,
  `[FMOD] loadFromWeb … result = ERR_FORMAT`,
  `BankLoadException: Could not load bank … : ERR_FORMAT`.
- **Root cause:** The package contained the main Unity build but not the
  `StreamingAssets` dependency tree. Bank names are constructed at runtime
  from `Module.streamingAssetsUrl`, so static scans can never find them.
- **Fix:** Bounded, policy-gated StreamingAssets discovery
  (`engines/unity/unity.streaming-assets*.ts`): static refs + remote
  browser observation + local-package observation, downloaded into
  `StreamingAssets/…` and listed in the manifest.
- **Verify:** `validate:real` → `RUNTIME_OK`, `streamingAssetsFailures: []`;
  serve the package and confirm both banks return 200.
- **First seen:** Traffic Rider (CrazyGames), Sep 2026.

## UNITY-DETECT-001 — Unity game detected as `unknown` (hashed filenames)

- **Status:** solved
- **Symptoms:** `detection: { engine: "unknown", confidence: < 0.5 }` on a
  game whose entry embeds `"loader":"unity20xx"`, `unityLoaderUrl` and a
  full `unityConfigOptions` triple, with files like `962b….js`,
  `….wasm.br`, `….data.br`, `….js.br`.
- **Root cause:** Detection and classification assumed conventional
  filenames (`*.loader.js`, `*.framework.js`); content-hashed builds carry
  no such patterns, and the adapter flattened role-labeled delivery URLs
  into anonymous hints.
- **Fix:** Role-labeled `unityBuild` hints across the adapter→engine
  boundary (`sources/source.interface.ts`); delivery-manifest + hashed-build
  detector signals with a conclusive-manifest confidence floor
  (`engines/unity/unity.detector.ts`); roles stage in config discovery;
  entry-referenced loader fallback in the validator.
- **Verify:** `validate:real` reports `engine: "unity"`, confidence ≥ 0.5;
  package contains decompressed hashed `Build/*` assets.
- **First seen:** Nuts Puzzle: Sort By Color (CrazyGames), Sep 2026.

## UNITY-RT-001 — premature RUNTIME_OK before post-boot asset requests

- **Status:** solved
- **Symptoms:** Validation reports `RUNTIME_OK`, but a manually served
  package later 404s on game assets requested after Unity initialization.
- **Root cause:** The validator settled on boot signals and ignored
  same-origin failures of non-artifact requests (`StreamingAssets`, JSON…).
- **Fix:** Track every failed same-origin request (`failedGameAssets`,
  StreamingAssets subset); post-init settle window
  (`RUNTIME_VALIDATION_SETTLE_MS`) so late failures flip the verdict to
  `RUNTIME_ERROR` (`runtime/playwright-runtime-validator.ts`,
  `runtime/init-signals.ts`).
- **Verify:** A package missing a bank fails with `UNITY_RUNTIME_ASSET_MISSING`;
  a complete package stays `RUNTIME_OK`.
- **First seen:** Traffic Rider (CrazyGames), Sep 2026.

## UNITY-RT-002 — init probes stall on fully booted heavy games

- **Status:** solved
- **Symptoms:** `RUNTIME_TIMEOUT` with `missingSignals: ["canvas",
  "explicit-ready"]` although assets loaded with zero errors; or the run
  hangs past its timeout. `page.evaluate` never resolves once the game runs
  full-tilt (renderer main thread saturated).
- **Root cause:** Unbounded DOM probes + evidence retraction on probe
  timeout: a timed-out probe reported absence and erased earlier positives.
- **Fix:** Hard probe timeout (`RUNTIME_VALIDATION_PROBE_TIMEOUT_MS`),
  teardown guards, and sticky (monotonic) canvas/explicit evidence —
  timeouts never retract earlier positives.
- **Verify:** Heavy game validates `RUNTIME_OK` in ~13 s instead of timing out.
- **First seen:** Traffic Rider (CrazyGames), Sep 2026.

## DISCOVERY-001 — remote portal page never boots in automation

- **Status:** solved (by design)
- **Symptoms:** Remote browser observation records zero game requests;
  page stuck at loader 0% with connection-gated overlays while ads/trackers
  fire normally.
- **Root cause:** Portal shells gate booting on conditions automation cannot
  satisfy; the self-contained local package boots headless without them.
- **Fix:** Local-package observation is the primary runtime signal; remote
  observation stays a bounded best-effort supplement. Do NOT "fix" this by
  clicking through portal overlays — that couples the importer to portal UI.
- **Verify:** Discovery diagnostics show local observation finding the
  dependencies remote observation missed.
- **First seen:** Traffic Rider (CrazyGames), Sep 2026.

## EXT-001 — external SDK/service requests at runtime

- **Status:** solved (by policy)
- **Symptoms:** Requests to hosts like `sdk.crazygames.com` observed during
  validation, recorded as `EXTERNAL_REFERENCE`. Game still initializes.
- **Root cause:** Expected: portal SDK/ads/analytics live outside the
  package and must never be bundled.
- **Fix:** None needed — record, never proxy/bundle. If a game CANNOT run
  without an external backend (multiplayer, accounts), it is not
  downloadable: reject with a clear `EXTERNAL_REFERENCE` reason instead of
  attempting repairs.
- **Verify:** `externalRequests` listed, `success` unaffected for optional
  services.
- **First seen:** Nuts Puzzle: Sort By Color (CrazyGames), Sep 2026.

## NOISE-001 — browser/chrome noise mistaken for game failures

- **Status:** solved
- **Symptoms:** `contentscript.js`, `ObjectMultiplex`,
  `MaxListenersExceededWarning`, extension-scheme messages, or the
  auto-requested `/favicon.ico` 404 appearing in console/network logs.
- **Root cause:** Browser chrome, not the game.
- **Fix:** Explicit noise filters (`isExtensionNoise`, benign local paths)
  in the runtime validator. Never widen these without a real-game reason.
- **Verify:** Healthy package stays `RUNTIME_OK` with noise present
  (covered by `runtime-health.spec.ts`).
- **First seen:** Traffic Rider (CrazyGames), Sep 2026.

## OPS-001 — `ENOSPC: no space left on device` during validation

- **Status:** solved (operational)
- **Symptoms:** `validate:real` fails mid-import with `ENOSPC` although the
  code is correct.
- **Root cause:** Stale `validate-real-*` / `dbg-real-*` temp dirs (each
  ~100 MB) filled the drive.
- **Fix:** Delete stale temp package dirs and rerun. No code change.
- **Verify:** Free space > 1 GB before rerunning.
- **First seen:** Sep 2026 (local environment).

## UNITY-ADDR-001 — Addressables 404 (`aa/settings.json`) long after boot

- **Status:** solved (mechanism merged, verified on Drive Quest — see below)
- **Symptoms:** Healthy boot (all build assets 200, FMOD fine), then much
  later — typically at gameplay start — `GET …/StreamingAssets/aa/
  settings.json → 404`, followed by `RemoteProviderException:
  TextDataProvider: unable to load from url`, `RuntimeData is null`,
  `Addressables - Unable to load runtime data`,
  `InvalidKeyException: No Location found for Key=…`, and finally
  `NullReferenceException`. Everything else in the log is benign noise
  (ObjectMultiplex, favicon 404, AudioContext autoplay warnings, ETC2 /
  Convex Mesh warnings, `Trying to get length of sound` chatter,
  ByteBrew/CrazySDK init lines).
- **Root cause:** Unity Addressables content (cars, tracks, …) is described
  by a content catalog the game fetches lazily. Bank-style runtime
  observation can never see these requests (they fire after user
  interaction), and bank-name construction has no filenames to scan — the
  catalog itself is the only discovery source. Additionally, the
  Addressables runtime is usually compiled into the WASM binary, so a
  text-signal gate on the loader/framework JS (which was the original
  design) silently skips the phase for many games — the first
  implementation shipped exactly this and correctly found nothing.
- **Fix:** Addressables tree phase (`engines/unity/unity.addressables.ts`
  + `downloadAddressablesTree`): probe `<streaming-assets-base>/aa/
  settings.json` candidates (policy-gated, bounded); download the catalog
  plus its `m_InternalId` entries under the canonical
  `StreamingAssets/…` layout; rewrite packaged IDs catalog-relative;
  absolute external IDs are recorded as external references, never bundled.
  The phase now runs **unconditionally** for every Unity game (signals in
  JS text were never reliable — WASM-compiled Addressables is invisible to
  regex), so the catalog probe itself is the signal. A missing catalog is
  normal for non-Addressables games and skips silently-ish (info
  diagnostic `UNITY_ADDRESSABLES_CATALOG_MISSING`), costing at most 2
  bounded, policy-gated HTTP requests.
- **Verify:** `StreamingAssets/aa/settings.json` packaged with rewritten
  IDs; served package returns it 200; no `Addressables - Unable to load`
  cascade in the console.
- **First seen:** 2022.3 Unity racing build served locally (user console
  log), Sep 2026. Drive Quest confirmed end-to-end: catalog exists at
  `https://files.crazygames.com/drive-quest---car-game/20/v17/
  StreamingAssets/aa/settings.json` (200) + `aa/catalog.json` (200);
  NOT at any unversioned base (`…/drive-quest---car-game/StreamingAssets/
  aa/…` 404) — the versioned path (`20/v17/`) comes from the delivery
  config's `streamingAssetsUrl`, which is now what the probe uses.

## OPEN-001 — non-Unity engines in `validate:real`

- **Status:** open (limitation, not a bug)
- **Symptoms:** `validate:real` exits early with `Real validation supports
  Unity builds; detected: <other>` (e.g. generic HTML5/Cocos/Construct).
- **Root cause:** The script is Unity-only by design; the worker pipeline
  already supports the generic HTML5 engine path.
- **Fix (when needed):** Extend the script to validate generic-HTML5
  packages (package validation + runtime smoke test) instead of throwing.
  Do NOT force non-Unity sources through the Unity importer.
- **First seen:** Sep 2026 (triage only, no failing game attached yet).

---

## Template for new entries (copy/paste)

```text
## <ID> — <short title>

- **Status:** open|solved
- **Symptoms:** <exact console/network signals>
- **Root cause:** <1–2 sentences>
- **Fix:** <files changed or action to take>
- **Verify:** <how to confirm>
- **First seen:** <game + date>
```
