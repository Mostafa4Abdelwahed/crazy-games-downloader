import { Injectable } from '@nestjs/common';
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

    // 2. Discover loader scripts: static <script src> first, then explicit
    //    adapter asset hints matching the loader artifact pattern (M3.1 —
    //    JS-bootstrapped frames expose no static script tag). No filename
    //    guessing: only already-discovered explicit URLs are eligible.
    const candidates = this.parser.findLoaderScriptUrls(html);
    const loaderRefs = candidates.filter((u) =>
      u.toLowerCase().includes('loader'),
    );
    let loaderRef = loaderRefs[0] ?? candidates[0];
    let loaderFromHints = false;
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
    // adapter hints -> fail closed with UNITY_CONFIG_NOT_FOUND.
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
    // Unity build artifacts, deduped). Adapter hints only ever ADD known
    // engine artifacts; they never change config parsing.
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
   * loader generations resolve locally.
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
