import { Injectable, Optional } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GamePackage,
  ImportContext,
  ImportLimits,
  DetectionContext,
  DetectionResult,
  GameEngineImporter,
  UnityBuild,
} from '../../core/types';
import { SecureDownloader } from '../../core/downloader';
import { SourcePolicyService } from '../../core/source-policy';
import { UnityDetector } from './unity.detector';
import { UnityLoaderParser, findLoaderUrlInHints } from './unity.loader-parser';
import { UnityAssetResolver } from './unity.asset-resolver';
import { UnityConfigDiscovery } from './unity.config-discovery';
import { UnityDecompressor } from './unity.decompressor';
import { UnityStreamingAssetsDiscovery } from './unity.streaming-assets-discovery';
import { catalogCandidates } from './unity.addressables';
import {
  STREAMING_ASSETS_SEGMENT,
  defaultStreamingAssetsOptions,
  extractStreamingAssetsRefs,
  normalizeStreamingPrefix,
} from './unity.streaming-assets';
import {
  contentTypeForFile,
  normalizePackagePath,
} from '../../core/path-utils';
import {
  DiagnosticCode,
  DiagnosticLevel,
  ImportDiagnostic,
  ImportError,
  safeUrlForLog,
} from '../../core/diagnostics';

/**
 * Unity WebGL build artifact filename pattern (engine knowledge — NOT
 * source-specific). Used to recognize adapter-resolved asset hints.
 */
const UNITY_ARTIFACT_PATTERN =
  /\.(loader\.js|framework\.js|wasm|data|symbols\.json|unityweb)(\.br)?$/i;

/**
 * Unity WebGL engine importer.
 * Flow: fetch entry HTML -> discover *.loader.js -> multi-source build
 * config discovery (loader literals, caller document, external scripts,
 * adapter hints) -> resolve asset URLs -> download assets ->
 * brotli-decompress .br -> normalize into package/{index.html,Build/*,
 * manifest.json}.
 *
 * When the import context carries a platform-agnostic `resolvedSource`
 * (M2.5), its `entryUrl` is used as the fetch base and its `assetUrls`
 * that match Unity build artifacts are merged into the download set.
 * No source-specific logic lives here.
 */
@Injectable()
export class UnityImporter implements GameEngineImporter {
  name = 'unity';

  constructor(
    private readonly detector: UnityDetector,
    private readonly downloader: SecureDownloader,
    private readonly parser: UnityLoaderParser,
    private readonly resolver: UnityAssetResolver,
    private readonly decompressor: UnityDecompressor,
    private readonly discovery: UnityConfigDiscovery,
    private readonly policy: SourcePolicyService,
    @Optional()
    private readonly streamingAssets?: UnityStreamingAssetsDiscovery,
  ) {}

  async detect(context: DetectionContext): Promise<DetectionResult> {
    return this.detector.detect(context);
  }

  async import(context: ImportContext): Promise<GamePackage> {
    const { sourceUrl, workDir, limits, onProgress } = context;
    // Stage diagnostics stream to the worker via the optional sink; every
    // URL recorded here is log-sanitized (no query/fragment/secrets).
    const emit = (
      level: DiagnosticLevel,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ): void => {
      const d: ImportDiagnostic = details
        ? { level, code, message, details }
        : { level, code, message };
      try {
        context.collectDiagnostics?.(d);
      } catch {
        /* diagnostics must never break the import */
      }
    };
    const report = async (
      p: Partial<Parameters<NonNullable<typeof onProgress>>[0]>,
    ) => {
      if (onProgress) await onProgress(p as any);
    };
    const rawDir = path.join(workDir, 'raw');
    const pkgDir = path.join(workDir, 'package');
    await fs.promises.mkdir(rawDir, { recursive: true });
    await fs.promises.mkdir(pkgDir, { recursive: true });

    // 1. Fetch entry page (adapter-resolved entry when provided)
    const entryTarget = context.resolvedSource?.entryUrl ?? sourceUrl;
    const entry = await this.downloader.fetchBuffer(entryTarget, {
      timeoutMs: Math.min(30_000, limits.timeoutMs),
      maxBytes: limits.maxDownloadBytes,
    });
    const html = entry.body.toString('utf8').slice(0, 1_000_000);
    const baseUrl = entry.finalUrl;

    // 2. Discover loader scripts: static <script src> first, then the
    //    role-labeled adapter loader URL (explicit delivery semantics —
    //    content-hashed builds included), then adapter asset hints matching
    //    the loader artifact pattern (M3.1 — JS-bootstrapped frames expose
    //    no static script tag). No filename guessing: only
    //    already-discovered explicit URLs are eligible.
    const candidates = this.parser.findLoaderScriptUrls(html);
    const loaderRefs = candidates.filter((u) =>
      u.toLowerCase().includes('loader'),
    );
    let loaderRef = loaderRefs[0] ?? candidates[0];
    let loaderFromHints = false;
    const roleLoader = context.resolvedSource?.unityBuild?.loaderUrl?.trim();
    if (!loaderRef && roleLoader) {
      loaderRef = roleLoader;
      loaderFromHints = true;
      emit(
        'info',
        DiagnosticCode.UNITY_LOADER_FOUND,
        'Unity loader resolved from role-labeled adapter build URL (no static script tag)',
        { url: safeUrlForLog(roleLoader) },
      );
    }
    if (!loaderRef) {
      const hinted = findLoaderUrlInHints(
        context.resolvedSource?.assetUrls ?? [],
      );
      if (hinted) {
        loaderRef = hinted;
        loaderFromHints = true;
        emit(
          'info',
          DiagnosticCode.UNITY_LOADER_FOUND,
          'Unity loader resolved from adapter asset hint (no static script tag)',
          { url: safeUrlForLog(hinted) },
        );
      }
    }
    if (!loaderRef) {
      emit(
        'error',
        DiagnosticCode.UNITY_LOADER_NOT_FOUND,
        'Unity loader script not found in entry HTML',
      );
      throw new ImportError(
        DiagnosticCode.UNITY_LOADER_NOT_FOUND,
        'Unity loader script not found in entry HTML',
      );
    }
    const loaderUrl = new URL(loaderRef, baseUrl).toString();
    // SourcePolicy gate: the loader is a required asset — an unauthorized
    // loader host fails the import closed (SSRF is enforced in fetchBuffer).
    this.policy.assertAllowed(loaderUrl);
    emit('info', DiagnosticCode.UNITY_LOADER_FOUND, 'Unity loader discovered', {
      url: safeUrlForLog(loaderUrl),
    });
    await report({ currentStep: 'resolving', totalFiles: 5 });

    // 3. Download loader + multi-source config discovery (M3.1).
    // Priority: loader literals -> caller document -> external scripts ->
    // role-labeled adapter build -> adapter hints -> fail closed with
    // UNITY_CONFIG_NOT_FOUND.
    const loaderRes = await this.downloader.fetchBuffer(loaderUrl, {
      timeoutMs: Math.min(30_000, limits.timeoutMs),
      maxBytes: limits.maxDownloadBytes,
    });
    this.policy.assertAllowed(loaderRes.finalUrl);
    const loaderJs = loaderRes.body.toString('utf8');
    const discovered = await this.discovery.discover({
      loaderJs,
      loaderUrl: loaderRes.finalUrl,
      entryHtml: html,
      entryUrl: baseUrl,
      adapterAssetUrls: context.resolvedSource?.assetUrls,
      adapterBuild: context.resolvedSource?.unityBuild,
      fetchExternalScript: (url) => this.fetchExternalScriptText(url, limits),
    });
    for (const d of discovered.diagnostics)
      emit(d.level, d.code, d.message, d.details);
    const withLoader = { ...discovered.build, loaderUrl };
    const {
      urls,
      build: resolved,
      diagnostics: resolveDiagnostics,
    } = this.resolver.resolve(withLoader, discovered.configBaseUrl);
    for (const d of resolveDiagnostics)
      emit(d.level, d.code, d.message, d.details);
    if (urls.length === 0) {
      emit(
        'error',
        DiagnosticCode.MISSING_ASSET,
        'Unity build resolved no downloadable assets (data/framework/wasm)',
      );
      throw new ImportError(
        DiagnosticCode.MISSING_ASSET,
        'Unity build resolved no downloadable assets (data/framework/wasm)',
      );
    }

    // 4. Download all assets (loader + resolved + adapter hints matching
    // Unity build artifacts + role-labeled adapter build URLs, deduped).
    // Adapter hints only ever ADD known engine artifacts or explicitly
    // labeled build URLs; they never change config parsing. Every URL is
    // SourcePolicy-gated at download (requested and final URL).
    const hinted = (context.resolvedSource?.assetUrls ?? []).filter((u) =>
      this.isUnityArtifactUrl(u),
    );
    const seen = new Set([loaderUrl, ...urls]);
    for (const h of hinted) {
      if (!seen.has(h)) {
        seen.add(h);
        urls.push(h);
      }
    }
    const roles = context.resolvedSource?.unityBuild;
    if (roles) {
      const roleFiles = [
        roles.dataUrl,
        roles.frameworkUrl,
        roles.codeUrl,
        roles.memoryUrl,
        roles.symbolsUrl,
      ];
      for (const raw of roleFiles) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        let abs: string;
        try {
          abs = new URL(raw.trim(), discovered.configBaseUrl).toString();
        } catch {
          continue;
        }
        if (!/^https?:/i.test(abs) || seen.has(abs)) continue;
        seen.add(abs);
        urls.push(abs);
        emit(
          'info',
          DiagnosticCode.UNITY_ASSET_URL_RESOLVED,
          'Queued role-labeled adapter build asset for download',
          { url: safeUrlForLog(abs) },
        );
      }
    }
    const allUrls = [loaderUrl, ...urls];
    await report({
      currentStep: 'downloading',
      totalFiles: allUrls.length + 1,
    });
    const downloaded: { url: string; filePath: string }[] = [];
    let done = 0;
    const loaderFileName =
      path.posix.basename(new URL(loaderUrl).pathname) || 'game.loader.js';
    const loaderRawPath = path.join(rawDir, loaderFileName);
    await fs.promises.writeFile(loaderRawPath, loaderRes.body);
    downloaded.push({ url: loaderUrl, filePath: loaderRawPath });
    done++;
    await report({ downloadedFiles: done });

    for (const u of urls) {
      // SourcePolicy gate per required asset (requested and final URLs:
      // redirects must not escape the allowlist either).
      this.policy.assertAllowed(u);
      const res = await this.downloader.fetchBuffer(u, {
        timeoutMs: Math.min(60_000, limits.timeoutMs),
        maxBytes: limits.maxDownloadBytes,
      });
      this.policy.assertAllowed(res.finalUrl);
      let bytes = res.body;
      const urlPath = new URL(res.finalUrl).pathname;
      let fileName = path.posix.basename(urlPath) || `asset-${done}`;
      if (this.decompressor.isBrotliFile(fileName)) {
        let alreadyPlain = false;
        try {
          const out = await this.decompressor.decompressIfNeeded(
            bytes,
            fileName,
            res.contentEncoding,
          );
          bytes = out.bytes;
          alreadyPlain = out.alreadyPlain;
        } catch (err) {
          emit(
            'error',
            DiagnosticCode.DECOMPRESSION_FAILED,
            `Brotli decompression failed for ${fileName}`,
            { file: fileName },
          );
          throw err;
        }
        fileName = this.decompressor.stripBrSuffix(fileName);
        if (alreadyPlain) {
          emit(
            'warning',
            DiagnosticCode.BROTLI_DECOMPRESSED,
            `Brotli asset arrived transport-decoded; using response bytes for ${fileName}`,
            { file: fileName },
          );
        } else {
          emit(
            'info',
            DiagnosticCode.BROTLI_DECOMPRESSED,
            `Decompressed Brotli asset ${fileName}`,
            { file: fileName, bytes: bytes.length },
          );
        }
      }
      const dest = path.join(rawDir, fileName);
      await fs.promises.writeFile(dest, bytes);
      downloaded.push({ url: res.finalUrl, filePath: dest });
      done++;
      emit('info', DiagnosticCode.ASSET_DOWNLOADED, `Downloaded ${fileName}`, {
        url: safeUrlForLog(res.finalUrl),
        bytes: bytes.length,
      });
      await report({ downloadedFiles: done });
    }

    // 4b. Bounded StreamingAssets dependency discovery (generic, M3.2).
    // The Unity config value `streamingAssetsUrl` is an expectation signal
    // only: actual files are discovered from observed runtime requests
    // under that prefix (+ static quoted refs in downloaded text), never
    // hardcoded and never crawled blindly. Adapter-hint configs may carry
    // the prefix signal; when no explicit signal exists, static refs and
    // segment-scoped runtime observation still apply. Every candidate is
    // gated by SourcePolicy (requested + final URL) and downloaded through
    // the SSRF-guarded downloader.
    const streamingFiles: { path: string; sourceUrl: string }[] = [];
    {
      const sa = await this.discoverStreamingAssets({
        streamingAssetsUrl: resolved.streamingAssetsUrl,
        configBaseUrl: discovered.configBaseUrl,
        remoteEntryUrl: entryTarget,
        loaderJs,
        downloaded,
        pkgDir,
        limits,
        emit,
      });
      for (const f of sa) streamingFiles.push(f);
    }

    // 5. Normalize into package/
    const buildDir = path.join(pkgDir, 'Build');
    await fs.promises.mkdir(buildDir, { recursive: true });
    const files: GamePackage['files'] = [];
    const name = this.deriveName(sourceUrl);

    // Localize the build config: map every resolved absolute asset URL to
    // its packaged relative path (Build/<basename>). Only known config
    // keys are ever rewritten, and only to paths of files we downloaded.
    const localByUrl = new Map<string, string>();
    for (const d of downloaded) {
      localByUrl.set(d.url, `Build/${path.basename(d.filePath)}`);
    }
    const localConfig = this.buildLocalConfigMapping(resolved, localByUrl);

    // Localize embedded config literals in the packaged loader (narrow,
    // known-key-only rewrite): a loader carrying absolute remote asset
    // URLs (content-hashed builds sometimes do) would otherwise keep
    // post-boot requests on the remote origin instead of the
    // self-contained package. Generic loaders without literals are
    // untouched; only keys pointing at files we downloaded are rewritten.
    await this.localizePackagedLoader(
      loaderRawPath,
      loaderJs,
      localConfig,
      emit,
    );

    let safeHtml: string;
    if (loaderFromHints) {
      // The entry carried no loader tag (JS-bootstrapped frame): its shell
      // markup only boots remote portal code, so a FRESH minimal Unity
      // entry is generated from the localized config instead of keeping
      // remote-bootstrap dead code that would leak external requests.
      safeHtml = this.buildStandaloneEntry(loaderFileName, localConfig, name);
      emit(
        'info',
        DiagnosticCode.UNITY_ENTRY_BOOTSTRAP_GENERATED,
        'Generated local Unity bootstrap entry (no static loader tag)',
        { loader: `Build/${loaderFileName}` },
      );
    } else {
      // index.html: keep original entry HTML but rewrite loader src to local
      // Build/<loader> plus known inline config refs to local paths —
      // narrowly scoped, single tag + known keys only.
      const localLoader = `Build/${loaderFileName}`;
      safeHtml = this.parser.rewriteInlineConfigRefs(
        this.rewriteLoaderSrcOnly(html, loaderRef, localLoader),
        localConfig,
      );
    }
    await fs.promises.writeFile(
      path.join(pkgDir, 'index.html'),
      safeHtml,
      'utf8',
    );

    const pushFile = async (absPath: string, rel: string) => {
      const safe = normalizePackagePath(rel);
      const st = await fs.promises.stat(absPath);
      files.push({
        path: safe,
        bytes: st.size,
        contentType: contentTypeForFile(safe),
      });
    };

    const indexStat = await fs.promises.stat(path.join(pkgDir, 'index.html'));
    files.push({
      path: 'index.html',
      bytes: indexStat.size,
      contentType: 'text/html',
    });

    for (const d of downloaded) {
      const base = path.basename(d.filePath);
      const dest = path.join(buildDir, base);
      if (d.filePath !== dest) {
        await fs.promises.copyFile(d.filePath, dest);
      }
      await pushFile(dest, `Build/${base}`);
    }

    for (const s of streamingFiles) {
      const abs = path.join(pkgDir, ...s.path.split('/'));
      await pushFile(abs, s.path);
    }

    // 5b. Local-package completion loop: boot the provisional package in
    // an isolated browser and package any additional StreamingAssets
    // dependencies it requests (FMOD banks are constructed at runtime, so
    // static signals alone cannot find them). Downloaded through the same
    // policy/SSRF-guarded pipeline and merged into the manifest below.
    {
      const already = new Set(streamingFiles.map((s) => s.path));
      const extra = await this.completeStreamingAssetsFromLocalPackage({
        pkgDir,
        signal: resolved.streamingAssetsUrl,
        configBaseUrl: discovered.configBaseUrl,
        already,
        limits,
        emit,
      });
      for (const f of extra) {
        const abs = path.join(pkgDir, ...f.path.split('/'));
        await pushFile(abs, f.path);
        streamingFiles.push(f);
      }
    }

    // 5c. Addressables content tree: games using Unity Addressables fetch
    // a content catalog (`StreamingAssets/aa/settings.json`) and its
    // bundles long after boot (gameplay start). The Addressables runtime
    // is often compiled into the WASM binary, so there is no reliable
    // text signal — the catalog probe itself is the signal; a missing
    // catalog simply skips this phase. Runs unconditionally and bounded.
    {
      const already = new Set(streamingFiles.map((s) => s.path));
      const extra = await this.discoverAddressablesTree({
        signal: resolved.streamingAssetsUrl,
        configBaseUrl: discovered.configBaseUrl,
        already,
        pkgDir,
        limits,
        emit,
      });
      for (const f of extra) {
        const abs = path.join(pkgDir, ...f.path.split('/'));
        await pushFile(abs, f.path);
        streamingFiles.push(f);
      }
    }

    // Copy original loader body into package Build/ too if raw==dest handled above.
    void resolved;
    const totalBytes = files.reduce((a, f) => a + f.bytes, 0);
    const manifest: GamePackage['manifest'] = {
      name,
      engine: 'unity',
      entryFile: 'index.html',
      createdAt: new Date().toISOString(),
      sourceUrl,
      fileCount: files.length,
      totalBytes,
      slug: this.deriveSlug(name),
      version: '1',
      ...(context.resolvedSource?.source
        ? { source: { platform: context.resolvedSource.source } }
        : {}),
      assets: files.map((f) => ({
        path: f.path,
        bytes: f.bytes,
        ...(f.contentType ? { contentType: f.contentType } : {}),
      })),
    };
    await fs.promises.writeFile(
      path.join(pkgDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    const manifestStat = await fs.promises.stat(
      path.join(pkgDir, 'manifest.json'),
    );
    files.push({
      path: 'manifest.json',
      bytes: manifestStat.size,
      contentType: 'application/json',
    });
    manifest.fileCount = files.length;
    manifest.totalBytes = files.reduce((a, f) => a + f.bytes, 0);
    await fs.promises.writeFile(
      path.join(pkgDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    // refresh manifest size entry
    const m2 = await fs.promises.stat(path.join(pkgDir, 'manifest.json'));
    const mf = files.find((f) => f.path === 'manifest.json');
    if (mf) mf.bytes = m2.size;
    manifest.totalBytes = files.reduce((a, f) => a + f.bytes, 0);
    await fs.promises.writeFile(
      path.join(pkgDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    await report({ currentStep: 'validating' });
    return { manifest, rootPath: pkgDir, files };
  }

  /**
   * Bounded StreamingAssets dependency phase (generic, M3.2).
   *
   * 1. Static refs from the loader text + downloaded framework text.
   * 2. Runtime network observation of the authorized remote entry in an
   *    isolated browser (skipped when disabled/unavailable — static
   *    signals alone still work).
   * 3. Policy-gated, deduped, capped download into the package's
   *    `StreamingAssets/...` tree (nesting preserved).
   *
   * Runs even without an explicit `streamingAssetsUrl` signal: static refs
   * imply the conventional prefix, and runtime observation falls back to
   * matching any URL carrying the `StreamingAssets` segment. Fully skipped
   * only when there is no signal, no static ref, AND runtime observation
   * is disabled.
   */
  private async discoverStreamingAssets(args: {
    streamingAssetsUrl?: string;
    configBaseUrl: string;
    remoteEntryUrl: string;
    loaderJs: string;
    downloaded: { url: string; filePath: string }[];
    pkgDir: string;
    limits: ImportLimits;
    emit: (
      level: DiagnosticLevel,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) => void;
  }): Promise<{ path: string; sourceUrl: string }[]> {
    const {
      streamingAssetsUrl,
      configBaseUrl,
      remoteEntryUrl,
      loaderJs,
      downloaded,
      pkgDir,
      limits,
      emit,
    } = args;
    const svc =
      this.streamingAssets ??
      new UnityStreamingAssetsDiscovery(this.downloader, this.policy);
    const opts = defaultStreamingAssetsOptions();
    const signal = (streamingAssetsUrl ?? '').trim();
    // Static signals: loader text + already-downloaded framework text.
    const staticPaths = new Set<string>();
    for (const p of extractStreamingAssetsRefs(loaderJs)) staticPaths.add(p);
    for (const d of downloaded) {
      if (!/\.framework\.js$/i.test(d.filePath)) continue;
      try {
        const text = await fs.promises.readFile(d.filePath, 'utf8');
        for (const p of extractStreamingAssetsRefs(text.slice(0, 1_000_000))) {
          staticPaths.add(p);
        }
      } catch {
        /* unreadable framework — runtime observation still applies */
      }
    }
    const runtimeEnabled =
      (
        process.env.UNITY_STREAMING_ASSETS_RUNTIME_DISCOVERY ?? 'true'
      ).toLowerCase() !== 'false';
    if (signal) {
      if (!normalizeStreamingPrefix(signal)) {
        emit(
          'warning',
          DiagnosticCode.EXTERNAL_REFERENCE,
          'Ignoring unresolvable streamingAssetsUrl signal',
        );
        return [];
      }
    } else if (staticPaths.size === 0 && !runtimeEnabled) {
      emit(
        'info',
        DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_COMPLETED,
        'StreamingAssets discovery skipped: no prefix signal, no static refs, runtime observation disabled',
      );
      return [];
    }
    // No explicit signal: match any URL carrying the StreamingAssets
    // segment; resolve static refs against the conventional prefix.
    const matchBase = signal || '';
    const resolveBase = signal || STREAMING_ASSETS_SEGMENT;
    const prefix =
      normalizeStreamingPrefix(resolveBase) ?? STREAMING_ASSETS_SEGMENT;

    // Runtime observation (bounded, isolated, policy-gated inside).
    let observedUrls: string[] = [];
    if (runtimeEnabled) {
      try {
        const obs = await svc.collectRuntimeUrls({
          entryUrl: remoteEntryUrl,
          configBaseUrl,
          streamingAssetsUrl: matchBase,
          timeoutMs: Math.min(opts.discoveryTimeoutMs, limits.timeoutMs),
          maxFiles: opts.maxFiles,
        });
        for (const d of obs.diagnostics)
          emit(d.level, d.code, d.message, d.details);
        observedUrls = obs.urls;
      } catch (err) {
        emit(
          'warning',
          DiagnosticCode.NETWORK_FAILURE,
          'StreamingAssets runtime discovery failed; continuing with static signals',
          { reason: (err as Error).message.slice(0, 200) },
        );
      }
    }

    const { urls: candidates, limitReached } = svc.resolveCandidates({
      observedUrls,
      staticPaths: [...staticPaths],
      streamingAssetsUrl: matchBase,
      staticResolveBase: resolveBase,
      configBaseUrl,
      maxFiles: opts.maxFiles,
    });
    if (limitReached) {
      emit(
        'warning',
        DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_LIMIT_REACHED,
        `StreamingAssets candidate cap reached (${opts.maxFiles}); additional dependencies ignored`,
        { maxFiles: opts.maxFiles },
      );
    }
    if (candidates.length === 0) {
      emit(
        'info',
        DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_COMPLETED,
        'StreamingAssets discovery completed: no dependencies observed',
        { prefix },
      );
      return [];
    }
    return this.downloadStreamingCandidates(
      candidates,
      { pkgDir, limits, emit },
      `StreamingAssets discovery completed`,
      { prefix },
    );
  }

  /**
   * Local-package completion loop (generic, M3.2): boot the provisional
   * package in an isolated browser and package any additional
   * StreamingAssets dependencies it requests. FMOD bank names are
   * constructed at runtime from the config prefix, so this is the only
   * signal that can find them; portal pages frequently refuse to boot
   * under automation, which is why the LOCAL package (proven bootable by
   * runtime validation) is observed instead of the remote source.
   */
  private async completeStreamingAssetsFromLocalPackage(args: {
    pkgDir: string;
    signal?: string;
    configBaseUrl: string;
    already: Set<string>;
    limits: ImportLimits;
    emit: (
      level: DiagnosticLevel,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) => void;
  }): Promise<{ path: string; sourceUrl: string }[]> {
    const { pkgDir, signal, configBaseUrl, already, limits, emit } = args;
    const localEnabled =
      (
        process.env.UNITY_STREAMING_ASSETS_LOCAL_DISCOVERY ?? 'true'
      ).toLowerCase() !== 'false';
    if (!localEnabled) {
      emit(
        'info',
        DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_COMPLETED,
        'StreamingAssets local completion disabled; package keeps pre-packaged dependencies only',
      );
      return [];
    }
    const svc =
      this.streamingAssets ??
      new UnityStreamingAssetsDiscovery(this.downloader, this.policy);
    const opts = defaultStreamingAssetsOptions();
    const remaining = opts.maxFiles - already.size;
    if (remaining <= 0) {
      emit(
        'warning',
        DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_LIMIT_REACHED,
        'StreamingAssets file cap already reached; skipping local completion',
        { maxFiles: opts.maxFiles },
      );
      return [];
    }
    const localTimeout = Math.min(
      Number(process.env.UNITY_STREAMING_ASSETS_LOCAL_TIMEOUT_MS ?? 30_000),
      limits.timeoutMs,
    );
    let observed: string[] = [];
    try {
      const obs = await svc.observeLocalPaths({
        pkgDir,
        timeoutMs: localTimeout,
        maxFiles: opts.maxFiles,
        knownPaths: already,
      });
      for (const d of obs.diagnostics)
        emit(d.level, d.code, d.message, d.details);
      observed = obs.paths;
    } catch (err) {
      emit(
        'warning',
        DiagnosticCode.NETWORK_FAILURE,
        'StreamingAssets local observation failed; package keeps pre-packaged dependencies only',
        { reason: (err as Error).message.slice(0, 200) },
      );
      return [];
    }
    const fresh = observed.filter((p) => !already.has(p));
    if (fresh.length === 0) {
      return [];
    }
    const { urls: candidates } = svc.resolveCandidates({
      observedUrls: [],
      staticPaths: fresh,
      streamingAssetsUrl: '',
      staticResolveBase: (signal ?? '').trim() || STREAMING_ASSETS_SEGMENT,
      configBaseUrl,
      maxFiles: remaining,
    });
    if (candidates.length === 0) {
      emit(
        'warning',
        DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_FAILED,
        'Locally observed StreamingAssets paths resolve to no authorized remote URL',
        { count: fresh.length },
      );
      return [];
    }
    return this.downloadStreamingCandidates(
      candidates,
      { pkgDir, limits, emit },
      'StreamingAssets local completion finished',
      { count: candidates.length },
    );
  }

  /**
   * Policy/SSRF-guarded download of resolved StreamingAssets candidates
   * into the package tree, with shared limit/completion diagnostics.
   */
  private async downloadStreamingCandidates(
    candidates: Array<{ url: string; path: string }>,
    ctx: {
      pkgDir: string;
      limits: ImportLimits;
      emit: (
        level: DiagnosticLevel,
        code: string,
        message: string,
        details?: Record<string, unknown>,
      ) => void;
    },
    completedMessage: string,
    completedDetails: Record<string, unknown>,
  ): Promise<{ path: string; sourceUrl: string }[]> {
    const { pkgDir, limits, emit } = ctx;
    const svc =
      this.streamingAssets ??
      new UnityStreamingAssetsDiscovery(this.downloader, this.policy);
    const opts = defaultStreamingAssetsOptions();
    emit(
      'info',
      DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_STARTED,
      `StreamingAssets discovery: downloading ${candidates.length} file(s)`,
      { count: candidates.length },
    );
    const result = await svc.downloadAll(candidates, {
      timeoutMs: Math.min(opts.requestTimeoutMs, limits.timeoutMs),
      maxTotalBytes: Math.min(opts.maxTotalBytes, limits.maxDownloadBytes),
      writeFile: async (packagePath, bytes) => {
        const abs = path.join(pkgDir, ...packagePath.split('/'));
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, bytes);
      },
      onEvent: (d) => emit(d.level, d.code, d.message, d.details),
    });
    if (result.limitReached) {
      emit(
        'warning',
        DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_LIMIT_REACHED,
        'StreamingAssets download cap reached; package may be incomplete',
        { files: result.files.length, totalBytes: result.totalBytes },
      );
    }
    emit(
      'info',
      DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_COMPLETED,
      `${completedMessage}: ${result.files.length} file(s), ${result.totalBytes} bytes`,
      {
        count: result.files.length,
        totalBytes: result.totalBytes,
        ...completedDetails,
      },
    );
    return result.files;
  }

  /**
   * Rewrite known Unity config literals inside the packaged loader copy
   * to their local package paths (see {@link buildLocalConfigMapping}).
   * Static only, known keys only, downloaded files only. Generic loaders
   * without embedded literals are byte-identical afterwards.
   */
  private async localizePackagedLoader(
    loaderRawPath: string,
    loaderJs: string,
    localConfig: Record<string, string>,
    emit: (
      level: DiagnosticLevel,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) => void,
  ): Promise<void> {
    const allowed = new Set([
      'dataUrl',
      'frameworkUrl',
      'codeUrl',
      'wasmCodeUrl',
      'streamingAssetsUrl',
      'memoryUrl',
      'symbolsUrl',
    ]);
    const mapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(localConfig)) {
      if (allowed.has(k) && v) mapping[k] = v;
    }
    if (Object.keys(mapping).length === 0) return;
    try {
      const localized = this.resolver.rewriteKnownConfigRefs(loaderJs, mapping);
      if (localized !== loaderJs) {
        await fs.promises.writeFile(loaderRawPath, localized, 'utf8');
        emit(
          'info',
          DiagnosticCode.UNITY_ASSET_URL_RESOLVED,
          'Localized embedded config literals in packaged loader',
          { fields: Object.keys(mapping) },
        );
      }
    } catch {
      /* keep the original loader bytes on any rewrite failure */
    }
  }

  /**
   * Addressables content-tree phase (generic, M3.3).
   *
   * Runs unconditionally for Unity games: the Addressables runtime is
   * often compiled into the WASM binary, so no text signal (loader or
   * framework) is reliable. The catalog probe itself is the signal — a
   * missing catalog is normal for non-Addressables games and simply
   * skips silently after bounded, policy-gated probing.
   */
  private async discoverAddressablesTree(args: {
    signal?: string;
    configBaseUrl: string;
    already: Set<string>;
    pkgDir: string;
    limits: ImportLimits;
    emit: (
      level: DiagnosticLevel,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) => void;
  }): Promise<{ path: string; sourceUrl: string }[]> {
    const { signal, configBaseUrl, already, pkgDir, limits, emit } = args;
    const svc =
      this.streamingAssets ??
      new UnityStreamingAssetsDiscovery(this.downloader, this.policy);
    const opts = defaultStreamingAssetsOptions();
    const remainingFiles = opts.maxFiles - already.size;
    if (remainingFiles <= 0) {
      emit(
        'warning',
        DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_LIMIT_REACHED,
        'Addressables skipped: StreamingAssets file cap already reached',
        { maxFiles: opts.maxFiles },
      );
      return [];
    }
    const result = await svc.downloadAddressablesTree({
      candidateCatalogUrls: catalogCandidates(signal, configBaseUrl),
      writeFile: async (packagePath, bytes) => {
        const abs = path.join(pkgDir, ...packagePath.split('/'));
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, bytes);
      },
      timeoutMs: Math.min(opts.requestTimeoutMs, limits.timeoutMs),
      maxFiles: remainingFiles,
      maxTotalBytes: Math.min(opts.maxTotalBytes, limits.maxDownloadBytes),
      onEvent: (d) => emit(d.level, d.code, d.message, d.details),
    });
    return result.files.filter((f) => !already.has(f.path));
  }

  /**
   * Fetch an explicitly referenced external script as text for static
   * config scanning (never executed). SourcePolicy is asserted by the
   * discovery stage before this is called; SSRF is enforced in fetchBuffer.
   */
  private async fetchExternalScriptText(
    url: string,
    limits: ImportLimits,
  ): Promise<string> {
    const res = await this.downloader.fetchBuffer(url, {
      timeoutMs: Math.min(30_000, limits.timeoutMs),
      maxBytes: Math.min(limits.maxDownloadBytes, 5_000_000),
    });
    this.policy.assertAllowed(res.finalUrl);
    return res.body.toString('utf8').slice(0, 1_000_000);
  }

  /** Accept only absolute http(s) URLs whose path is a Unity artifact. */
  private isUnityArtifactUrl(raw: string): boolean {
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      return UNITY_ARTIFACT_PATTERN.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  /** Narrowly-scoped rewrite of the single loader <script src> only. */
  private rewriteLoaderSrcOnly(
    html: string,
    originalRef: string,
    newRef: string,
  ): string {
    const escaped = originalRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(<script[^>]+src=["'])${escaped}(["'])`, 'i');
    if (re.test(html)) return html.replace(re, `$1${newRef}$2`);
    return html;
  }

  /**
   * Map resolved absolute asset URLs to packaged relative paths, keyed by
   * known Unity config key. codeUrl/wasmCodeUrl mirror each other so both
   * loader generations resolve locally. streamingAssetsUrl maps to the
   * local StreamingAssets prefix dir so post-boot bank requests stay
   * same-origin instead of leaking to the remote source.
   */
  private buildLocalConfigMapping(
    build: UnityBuild,
    localByUrl: Map<string, string>,
  ): Record<string, string> {
    const mapping: Record<string, string> = {};
    const take = (
      key:
        | 'dataUrl'
        | 'frameworkUrl'
        | 'codeUrl'
        | 'wasmCodeUrl'
        | 'memoryUrl'
        | 'symbolsUrl',
    ): void => {
      const abs = build[key];
      if (abs && localByUrl.has(abs)) {
        mapping[key] = localByUrl.get(abs) as string;
      }
    };
    take('dataUrl');
    take('frameworkUrl');
    take('codeUrl');
    take('wasmCodeUrl');
    take('memoryUrl');
    take('symbolsUrl');
    if (mapping['codeUrl'] && !mapping['wasmCodeUrl']) {
      mapping['wasmCodeUrl'] = mapping['codeUrl'];
    }
    if (mapping['wasmCodeUrl'] && !mapping['codeUrl']) {
      mapping['codeUrl'] = mapping['wasmCodeUrl'];
    }
    if (build.streamingAssetsUrl) {
      // Canonical local layout: StreamingAssets dependencies are always
      // packaged top-level (never nested under remote layout prefixes),
      // so the config must point there for post-boot requests to stay
      // same-origin.
      mapping['streamingAssetsUrl'] = STREAMING_ASSETS_SEGMENT;
    }
    return mapping;
  }

  /**
   * Generate a fresh, fully self-contained Unity entry document (M3.1) for
   * JS-bootstrapped frames that carried no static loader tag. The original
   * shell only boots remote portal code, so it is replaced — never
   * augmented — by a minimal standard-Unity page whose config references
   * packaged local paths only. All values derive from downloaded files;
   * nothing is guessed. The settle log line deliberately matches NO
   * runtime init pattern, so it can never self-confirm initialization.
   */
  private buildStandaloneEntry(
    loaderFileName: string,
    localConfig: Record<string, string>,
    gameName: string,
  ): string {
    const title = escapeHtml(gameName).slice(0, 120) || 'Unity WebGL game';
    const entries = Object.entries(localConfig)
      .map(([k, v]) => `  ${k}: "${v}"`)
      .join(',\n');
    return (
      '<!doctype html>\n' +
      '<html lang="en">\n' +
      '<head>\n' +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      `<title>${title} (local package)</title>\n` +
      '<style>html,body{margin:0;padding:0;height:100%;background:#231F20;}' +
      '#unity-canvas{width:100%;height:100%;display:block;}</style>\n' +
      '</head>\n' +
      '<body>\n' +
      '<canvas id="unity-canvas" width="960" height="600"></canvas>\n' +
      `<script src="Build/${loaderFileName}"></script>\n` +
      '<script>\n' +
      'var unityBuildConfig = {\n' +
      `${entries}\n` +
      '};\n' +
      'createUnityInstance(document.querySelector("#unity-canvas"), unityBuildConfig).then(function (instance) {\n' +
      '  window.unityInstance = instance;\n' +
      '  console.log("[local-package] createUnityInstance promise settled");\n' +
      '}).catch(function (err) {\n' +
      '  console.error("[local-package] bootstrap failed", err);\n' +
      '});\n' +
      '</script>\n' +
      '</body>\n' +
      '</html>\n'
    );
  }

  private deriveName(sourceUrl: string): string {
    try {
      const u = new URL(sourceUrl);
      const seg = u.pathname.split('/').filter(Boolean).pop() ?? u.hostname;
      return seg.slice(0, 100) || 'unity-game';
    } catch {
      return 'unity-game';
    }
  }

  private deriveSlug(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    return slug || 'game';
  }
}

/** Minimal HTML escaping for the generated entry title. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
