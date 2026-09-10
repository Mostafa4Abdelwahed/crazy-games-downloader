import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scoreSignals } from '../core/detector';
import { FetchResult, SecureDownloader } from '../core/downloader';
import { SourcePolicyService } from '../core/source-policy';
import { contentTypeForFile, normalizePackagePath } from '../core/path-utils';
import {
  DiagnosticCode,
  ImportDiagnostic,
  safeUrlForLog,
} from '../core/diagnostics';
import {
  DetectionContext,
  DetectionResult,
  DetectionSignal,
  GameEngineImporter,
  GamePackage,
  ImportContext,
} from '../core/types';

/**
 * Decisive signal: the CrazyGames portal explicitly declares `"loader":"html5"`.
 * Mirrors `unity-delivery-manifest` — an explicit loader declaration is
 * evidence of a different kind than heuristic pattern matching.
 */
const LOADER_HTML5_RE = /["']loader["']\s*:\s*["']html5["']/i;
const LOADER_OPTIONS_URL_RE =
  /["']loaderOptions["']\s*:\s*\{[^}]*?["']url["']\s*:\s*["'](?:https?:)?\/\//i;
const GAMEFRAME_RE = /gameframe/i;
const CRAZYGAMES_LOAD_RE = /crazygames\.load/i;
const SCRIPT_TAG_RE = /<script/i;

const MAX_ENTRY_BYTES = 5_000_000;
const MAX_ASSETS = 500;
const MAX_CSS_SECOND_PASS = 100;
// Runtime harvest bounds: JS string literals that look like asset paths,
// resolved against the entry document base and mirrored entry-relative.
const MAX_HARVESTED_REFS = 500;
const MAX_HARVEST_SCAN_BYTES = 2_000_000;
// TeaVM/libGDX web builds list every runtime resource in assets/assets.txt.
const MAX_MANIFEST_BYTES = 2_000_000;
const MAX_MANIFEST_ENTRIES = 2000;

/**
 * Generic HTML5 engine importer.
 *
 * Detect: explicit `"loader":"html5"` delivery declaration with confidence
 * floor (mirrors Unity's manifest floor).
 *
 * Import: fetch game entry document (the real `index.html`, not the
 * bootstrap shell), discover static resource references, download and
 * rewrite them to a local `assets/` tree, inject a minimal CrazyGames SDK
 * shim, and produce a self-contained `GamePackage`.
 */
@Injectable()
export class GenericHtml5Importer implements GameEngineImporter {
  name = 'generic-html5';

  constructor(
    private readonly downloader: SecureDownloader,
    private readonly policy: SourcePolicyService,
  ) {}

  async detect(context: DetectionContext): Promise<DetectionResult> {
    const html = (context.html ?? '').slice(0, 500_000);
    const portalHtml = (context.portalHtml ?? '').slice(0, 500_000);
    const has = (re: RegExp) => re.test(html) || re.test(portalHtml);

    const signals: DetectionSignal[] = [
      {
        name: 'loader-html5-name',
        weight: 6,
        matched: has(LOADER_HTML5_RE),
        detail: 'CrazyGames delivery declares loader=html5',
      },
      {
        name: 'loader-options-url',
        weight: 4,
        matched: has(LOADER_OPTIONS_URL_RE),
        detail: 'loaderOptions contains http(s) url',
      },
      {
        name: 'gameframe-sdk',
        weight: 2,
        matched: has(GAMEFRAME_RE) || has(CRAZYGAMES_LOAD_RE),
        detail: 'CrazyGames gameframe SDK references',
      },
      {
        name: 'has-script',
        weight: 1,
        matched: has(SCRIPT_TAG_RE),
        detail: 'executable script tag present',
      },
    ];

    const loaderNamed = signals[0].matched;
    return {
      engine: 'generic-html5',
      // An explicit `loader:"html5"` declaration is a decisive, explicit
      // delivery signal.  Floor at 0.6 so it always clears the Composite
      // 0.5 threshold — matching the Unity manifest floor pattern.
      confidence: loaderNamed
        ? Math.max(scoreSignals(signals), 0.6)
        : scoreSignals(signals),
      signals,
    };
  }

  async import(context: ImportContext): Promise<GamePackage> {
    const { sourceUrl, workDir, limits, onProgress } = context;
    const emit = (
      level: 'info' | 'warning' | 'error',
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

    const pkgDir = path.join(workDir, 'package');
    const assetsDir = path.join(pkgDir, 'assets');
    await fs.promises.mkdir(assetsDir, { recursive: true });

    // ── 1. Resolve fetch base ────────────────────────────────────────────
    const entryTarget =
      context.resolvedSource?.gameEntryUrl ??
      context.resolvedSource?.entryUrl ??
      sourceUrl;
    emit(
      'info',
      DiagnosticCode.HTML5_ENTRY_FOUND,
      'Generic HTML5 entry resolved',
      { url: safeUrlForLog(entryTarget) },
    );

    // ── 2. Fetch entry HTML ──────────────────────────────────────────────
    // game-files.crazygames.com enforces Referer-based hotlink protection.
    const referer = sourceUrl;
    const entryRes = await this.downloader.fetchBuffer(entryTarget, {
      timeoutMs: Math.min(30_000, limits.timeoutMs),
      maxBytes: Math.min(MAX_ENTRY_BYTES, limits.maxDownloadBytes),
      headers: { Referer: referer },
    });
    this.policy.assertAllowed(entryRes.finalUrl);
    const html = entryRes.body.toString('utf8').slice(0, MAX_ENTRY_BYTES);
    const baseUrl = entryRes.finalUrl;
    await report({ status: 'downloading', totalFiles: 2 });

    // ── 3. Discover resource references ──────────────────────────────────
    const refCandidates = discoverRefs(html, baseUrl);
    const uniqueAbs = [...new Set(refCandidates.map((r) => r.abs))];
    const toDownload = uniqueAbs.slice(0, MAX_ASSETS);
    if (uniqueAbs.length > MAX_ASSETS) {
      emit(
        'warning',
        DiagnosticCode.HTML5_ASSET_LIMIT_REACHED,
        `Asset cap reached (${MAX_ASSETS}) — ${uniqueAbs.length - MAX_ASSETS} references skipped`,
        { cap: MAX_ASSETS, discovered: uniqueAbs.length },
      );
    }

    // ── 4. Download assets + build rewrite map ───────────────────────────
    const byAbs = new Map<string, string>(); // abs URL → package-relative local path
    const files: GamePackage['files'] = [];
    const cssFiles: Array<{ absUrl: string; localPath: string }> = [];
    let downloaded = 0;
    await report({ totalFiles: toDownload.length + 2 });

    for (const abs of toDownload) {
      try {
        this.policy.assertAllowed(abs);
      } catch {
        emit(
          'warning',
          DiagnosticCode.EXTERNAL_REFERENCE,
          'Skipping unauthorized asset host',
          { url: safeUrlForLog(abs) },
        );
        continue;
      }

      let res: FetchResult;
      try {
        res = await this.downloader.fetchBuffer(abs, {
          timeoutMs: Math.min(30_000, limits.timeoutMs),
          maxBytes: limits.maxDownloadBytes,
          headers: { Referer: referer },
        });
      } catch (err) {
        emit(
          'warning',
          DiagnosticCode.NETWORK_FAILURE,
          `Asset download failed: ${(err as Error).message.slice(0, 200)}`,
          { url: safeUrlForLog(abs) },
        );
        continue;
      }
      this.policy.assertAllowed(res.finalUrl);
      await report({ downloadedFiles: ++downloaded });

      const localName = assetLocalName(res.finalUrl, res.contentType);
      const localRel = `assets/${localName}`;
      const absPath = path.join(assetsDir, localName);
      await fs.promises.writeFile(absPath, res.body);
      byAbs.set(abs, localRel);
      files.push({
        path: normalizePackagePath(localRel),
        bytes: res.body.length,
        contentType: contentTypeForFile(localRel),
      });
      emit(
        'info',
        DiagnosticCode.ASSET_DOWNLOADED,
        `Downloaded asset ${localName}`,
        {
          url: safeUrlForLog(res.finalUrl),
          bytes: res.body.length,
        },
      );

      const isCss =
        /^text\/css/i.test(res.contentType ?? '') ||
        /\.css(?:\?|$)/i.test(urlPathOf(res.finalUrl));
      if (isCss) {
        cssFiles.push({ absUrl: res.finalUrl, localPath: absPath });
      }
    }

    // ── 5. CSS second-pass: url() references inside stylesheets ──────────
    const cssSeen = new Set<string>();
    for (const css of cssFiles.slice(0, MAX_CSS_SECOND_PASS)) {
      if (cssSeen.has(css.localPath)) continue;
      cssSeen.add(css.localPath);
      let cssText: string;
      try {
        cssText = await fs.promises.readFile(css.localPath, 'utf8');
      } catch {
        continue;
      }
      // CSS url() refs resolve against the stylesheet's own URL, never the
      // HTML entry base.
      const cssBase = css.absUrl;
      const cssRefs = discoverCssRefs(cssText);
      for (const ref of cssRefs) {
        let refAbs: URL;
        try {
          refAbs = new URL(ref, cssBase);
        } catch {
          continue;
        }
        if (!['http:', 'https:'].includes(refAbs.protocol)) continue;
        const absStr = refAbs.toString();
        if (byAbs.has(absStr)) continue; // already downloaded
        try {
          this.policy.assertAllowed(absStr);
        } catch {
          continue;
        }
        try {
          const r2 = await this.downloader.fetchBuffer(absStr, {
            timeoutMs: Math.min(15_000, limits.timeoutMs),
            maxBytes: limits.maxDownloadBytes,
            headers: { Referer: referer },
          });
          this.policy.assertAllowed(r2.finalUrl);
          const name = assetLocalName(r2.finalUrl, r2.contentType);
          const rel = `assets/${name}`;
          await fs.promises.writeFile(path.join(assetsDir, name), r2.body);
          byAbs.set(absStr, rel);
          files.push({
            path: normalizePackagePath(rel),
            bytes: r2.body.length,
            contentType: contentTypeForFile(rel),
          });
          const cssContent = await fs.promises.readFile(css.localPath, 'utf8');
          const updated = cssContent.replace(
            new RegExp(escapeRegExp(ref), 'g'),
            rel,
          );
          if (updated !== cssContent) {
            await fs.promises.writeFile(css.localPath, updated, 'utf8');
            // Keep the packaged CSS size accurate after the in-place rewrite.
            const cssRel = `assets/${path.posix.basename(css.localPath)}`;
            const cssIdx = files.findIndex((f) => f.path === cssRel);
            if (cssIdx >= 0) {
              files[cssIdx].bytes = Buffer.byteLength(updated, 'utf8');
            }
          }
        } catch {
          /* css second-pass failures are non-fatal */
        }
      }
    }

    // ── 5b. Runtime harvest: JS string literals ────────────────────────
    // Games fetch most assets at runtime from JS (PixiJS loaders, XHR,
    // dynamic import()).  Those references are invisible to static HTML
    // discovery, so harvest quoted asset-like paths from the entry HTML
    // and every downloaded script, resolve them against the entry
    // document base, and store them mirrored at the entry-relative path
    // so runtime requests hit packaged files without touching JS bytes.
    const writeMirroredFile = async (
      rel: string,
      body: Buffer,
      via: string,
      remoteUrl: string,
    ): Promise<void> => {
      if (files.some((f) => f.path === rel)) return; // collision — keep first
      const dest = path.join(pkgDir, ...rel.split('/'));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, body);
      files.push({
        path: normalizePackagePath(rel),
        bytes: body.length,
        contentType: contentTypeForFile(rel),
      });
      await report({ downloadedFiles: ++downloaded });
      emit(
        'info',
        DiagnosticCode.HTML5_RUNTIME_ASSET_DISCOVERED,
        `Mirrored runtime asset ${rel}`,
        { url: safeUrlForLog(remoteUrl), bytes: body.length, via },
      );
    };
    const storeMirrored = async (
      absStr: string,
      via: string,
    ): Promise<void> => {
      const rel = mirrorLocalPath(baseUrl, absStr);
      if (!rel) return;
      if (files.some((f) => f.path === rel)) return;
      // Already downloaded as a hashed static asset?  Copy the bytes into
      // the mirrored location instead of re-downloading.
      const hashedRel = byAbs.get(absStr);
      if (hashedRel) {
        try {
          const body = await fs.promises.readFile(
            path.join(pkgDir, ...hashedRel.split('/')),
          );
          await writeMirroredFile(rel, body, via, absStr);
        } catch {
          /* copy failures are non-fatal */
        }
        return;
      }
      try {
        this.policy.assertAllowed(absStr);
      } catch {
        return;
      }
      try {
        const res = await this.downloader.fetchBuffer(absStr, {
          timeoutMs: Math.min(30_000, limits.timeoutMs),
          maxBytes: limits.maxDownloadBytes,
          headers: { Referer: referer },
        });
        this.policy.assertAllowed(res.finalUrl);
        await writeMirroredFile(rel, res.body, via, res.finalUrl);
      } catch {
        /* runtime-harvest failures are non-fatal by design */
      }
    };
    const harvestSources: string[] = [html];
    for (const f of files) {
      if (
        f.contentType === 'text/javascript' ||
        f.path.endsWith('.js') ||
        f.path.endsWith('.mjs')
      ) {
        try {
          const body = await fs.promises.readFile(
            path.join(pkgDir, ...f.path.split('/')),
            'utf8',
          );
          harvestSources.push(body);
        } catch {
          /* unreadable script — skip harvesting it */
        }
      }
    }
    const harvested = new Set<string>();
    for (const src of harvestSources) {
      for (const abs of harvestJsAssetRefs(src, baseUrl, MAX_HARVESTED_REFS)) {
        if (harvested.has(abs)) continue;
        harvested.add(abs);
        if (harvested.size > MAX_HARVESTED_REFS) break;
        await storeMirrored(abs, 'js-harvest');
      }
      if (harvested.size >= MAX_HARVESTED_REFS) break;
    }

    // ── 5c. TeaVM asset manifest ─────────────────────────────────────────
    // TeaVM/libGDX web builds (common on CrazyGames) list every runtime
    // resource in `assets/assets.txt` (`type:path:size:mime` per line).
    // The entries are entry-relative, so mirror the whole manifest.
    if (/teavm\//i.test(html) || /teaVM/i.test(html)) {
      const manifestAbs = new URL('assets/assets.txt', baseUrl).toString();
      try {
        this.policy.assertAllowed(manifestAbs);
        const mres = await this.downloader.fetchBuffer(manifestAbs, {
          timeoutMs: Math.min(15_000, limits.timeoutMs),
          maxBytes: Math.min(limits.maxDownloadBytes, MAX_MANIFEST_BYTES),
          headers: { Referer: referer },
        });
        this.policy.assertAllowed(mres.finalUrl);
        const entries = parseTeavmManifest(
          mres.body.toString('utf8', 0, MAX_MANIFEST_BYTES),
        );
        if (entries.length > 0) {
          emit(
            'info',
            DiagnosticCode.HTML5_MANIFEST_FOUND,
            `TeaVM asset manifest with ${entries.length} entries`,
            { url: safeUrlForLog(mres.finalUrl) },
          );
          const manifestRel = mirrorLocalPath(baseUrl, mres.finalUrl);
          if (manifestRel) {
            await writeMirroredFile(
              manifestRel,
              mres.body,
              'teavm-manifest',
              mres.finalUrl,
            );
          }
          for (const e of entries.slice(0, MAX_MANIFEST_ENTRIES)) {
            let abs: string;
            try {
              abs = new URL(e, mres.finalUrl).toString();
            } catch {
              continue;
            }
            await storeMirrored(abs, 'teavm-manifest');
          }
        }
      } catch {
        /* manifest probe failures are non-fatal */
      }
    }

    // ── 6. Rewrite HTML references ───────────────────────────────────────
    // Longest raws first so a short ref can never be rewritten inside a
    // longer one (e.g. `/app.js` inside `/app.js?v=2`).
    const sortedRefs = [...refCandidates].sort(
      (a, b) => b.raw.length - a.raw.length,
    );
    let rewrittenHtml = html;
    for (const ref of sortedRefs) {
      const localRel = byAbs.get(ref.abs);
      if (!localRel) continue; // unauthorized or failed — keep original raw
      rewrittenHtml = rewrittenHtml.split(ref.raw).join(localRel);
    }

    // ── 7. Inject CrazyGames SDK stub ────────────────────────────────────
    const STUB_SCRIPT = 'crazygames-sdk-stub.js';
    rewrittenHtml = injectSdkStub(rewrittenHtml, STUB_SCRIPT);
    emit(
      'info',
      DiagnosticCode.HTML5_SDK_STUB_INJECTED,
      'CrazyGames SDK stub injected',
      { script: STUB_SCRIPT },
    );
    await fs.promises.writeFile(
      path.join(pkgDir, STUB_SCRIPT),
      SDK_STUB,
      'utf8',
    );
    files.push({
      path: normalizePackagePath(STUB_SCRIPT),
      bytes: Buffer.byteLength(SDK_STUB, 'utf8'),
      contentType: 'text/javascript',
    });

    // ── 8. Write entry HTML ──────────────────────────────────────────────
    await fs.promises.writeFile(
      path.join(pkgDir, 'index.html'),
      rewrittenHtml,
      'utf8',
    );
    const indexStat = await fs.promises.stat(path.join(pkgDir, 'index.html'));
    files.unshift({
      path: 'index.html',
      bytes: indexStat.size,
      contentType: 'text/html',
    });

    // ── 9. Manifest ──────────────────────────────────────────────────────
    const name =
      context.resolvedSource?.metadata?.title?.trim() ??
      this.deriveName(sourceUrl);
    const totalAll = files.reduce((a, f) => a + f.bytes, 0);
    const manifest: GamePackage['manifest'] = {
      name,
      engine: 'generic-html5',
      entryFile: 'index.html',
      createdAt: new Date().toISOString(),
      sourceUrl,
      fileCount: 0,
      totalBytes: totalAll,
      slug: this.deriveSlug(name),
      version: '1',
      ...(context.resolvedSource?.source
        ? { source: { platform: context.resolvedSource.source } }
        : {}),
      // Asset inventory excludes manifest.json itself.
      assets: files.map((f) => ({
        path: f.path,
        bytes: f.bytes,
        ...(f.contentType ? { contentType: f.contentType } : {}),
      })),
    };
    // Write manifest, then refresh sizes so the manifest entry + totalBytes
    // stay consistent with the packaged file array (validator invariant).
    // A manifest that embeds its own byte count is self-referential, so the
    // final on-disk size can differ by bytes — the array is authoritative.
    const manifestPath = path.join(pkgDir, 'manifest.json');
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    const mfStat = await fs.promises.stat(manifestPath);
    files.push({
      path: 'manifest.json',
      bytes: mfStat.size,
      contentType: 'application/json',
    });
    manifest.fileCount = files.length;
    manifest.totalBytes = files.reduce((a, f) => a + f.bytes, 0);
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    const m2 = await fs.promises.stat(manifestPath);
    const mfEntry = files.find((f) => f.path === 'manifest.json');
    if (mfEntry) mfEntry.bytes = m2.size;
    manifest.fileCount = files.length;
    manifest.totalBytes = files.reduce((a, f) => a + f.bytes, 0);
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    await report({ currentStep: 'validating', progress: 80 });
    return { manifest, rootPath: pkgDir, files };

    await report({ currentStep: 'validating', progress: 80 });
    return { manifest, rootPath: pkgDir, files };
  }

  private deriveName(sourceUrl: string): string {
    try {
      const u = new URL(sourceUrl);
      const seg = u.pathname.split('/').filter(Boolean).pop() ?? u.hostname;
      return seg.replace(/-/g, ' ').slice(0, 100) || 'html5-game';
    } catch {
      return 'html5-game';
    }
  }

  private deriveSlug(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    return slug || 'html5-game';
  }
}

// ── Reference discovery helpers ──────────────────────────────────────────────

interface HtmlRef {
  raw: string; // original reference string as it appears in the HTML
  abs: string; // absolute http(s) URL
}

const SKIP_RE = /^(data|blob|about|javascript|mailto|tel):/i;

function discoverRefs(html: string, baseUrl: string): HtmlRef[] {
  const refs: HtmlRef[] = [];
  const seen = new Set<string>();

  const push = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed || SKIP_RE.test(trimmed)) return;
    let abs: URL;
    try {
      abs = new URL(trimmed, baseUrl);
    } catch {
      return;
    }
    if (!['http:', 'https:'].includes(abs.protocol)) return;
    const absStr = abs.toString();
    if (seen.has(absStr)) return;
    seen.add(absStr);
    refs.push({ raw: trimmed, abs: absStr });
  };

  // <script src>
  const scriptRe = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']{1,2000})["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html.slice(0, 3_000_000))) !== null) push(m[1]);

  // <link href> (stylesheet, preload, modulepreload, icon, manifest)
  const linkRe = /<link\b[^>]+?\bhref\s*=\s*["']([^"']{1,2000})["'][^>]*>/gi;
  while ((m = linkRe.exec(html.slice(0, 3_000_000))) !== null) {
    const tag = m[0];
    if (
      /rel\s*=\s*["']?(stylesheet|preload|modulepreload|icon|shortcut icon|manifest)/i.test(
        tag,
      )
    ) {
      push(m[1]);
    }
  }

  // <img src>
  const imgRe = /<img\b[^>]+?\bsrc\s*=\s*["']([^"']{1,2000})["'][^>]*>/gi;
  while ((m = imgRe.exec(html.slice(0, 3_000_000))) !== null) push(m[1]);

  // <video>/<audio src> and <source src>
  const mediaRe =
    /<(?:video|audio|source)\b[^>]+?\bsrc\s*=\s*["']([^"']{1,2000})["'][^>]*>/gi;
  while ((m = mediaRe.exec(html.slice(0, 3_000_000))) !== null) push(m[1]);

  return refs;
}

/**
 * Discover `url(...)` references inside a CSS text block (best-effort static
 * extraction — covers the most common patterns).
 */
function discoverCssRefs(cssText: string): string[] {
  const refs: string[] = [];
  const re = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cssText.slice(0, 1_000_000))) !== null) {
    const inner = m[2].trim();
    if (SKIP_RE.test(inner) || !inner) continue;
    refs.push(inner);
  }
  return refs;
}

const HARVEST_EXTS =
  'js|mjs|png|jpe?g|gif|webp|svg|bmp|ico|mp3|ogg|wav|m4a|flac|opus|' +
  'mp4|webm|json|txt|xml|csv|fnt|atlas|ttf|otf|woff2?|glsl|vert|frag|' +
  'bin|dat|wasm|pak|map';
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Harvest quoted asset-like paths from JS/HTML text (best-effort static
 * extraction of runtime references: PixiJS loader lists, XHR URLs, dynamic
 * imports).  Returns absolute http(s) URLs resolved against `baseUrl`.
 */
function harvestJsAssetRefs(
  text: string,
  baseUrl: string,
  cap: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(
    `["']([^"'\\s<>|\\\\]{1,200}\\.(?:${HARVEST_EXTS})(?:\\?[^"'\\s<>]*)?)["']`,
    'gi',
  );
  let m: RegExpExecArray | null;
  const src = text.slice(0, MAX_HARVEST_SCAN_BYTES);
  while ((m = re.exec(src)) !== null) {
    const raw = m[1];
    if (
      raw.includes('://') ||
      raw.includes('${') ||
      raw.includes('{') ||
      raw.includes('}') ||
      raw.startsWith('//') ||
      SCHEME_RE.test(raw)
    ) {
      continue;
    }
    let abs: URL;
    try {
      abs = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(abs.protocol)) continue;
    const absStr = abs.toString();
    if (seen.has(absStr)) continue;
    seen.add(absStr);
    out.push(absStr);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Parse a TeaVM `assets.txt` manifest (`type:path:size:mime` per line).
 * Returns the entry-relative resource paths.  Returns [] unless the text
 * convincingly looks like a manifest (majority of lines valid).
 */
function parseTeavmManifest(text: string): string[] {
  const entries: string[] = [];
  let valid = 0;
  let nonEmpty = 0;
  for (const line of text.split(/\r?\n/).slice(0, 10_000)) {
    const t = line.trim();
    if (!t) continue;
    nonEmpty++;
    const m = /^([A-Za-z]):([^:\n]{1,220}):(\d{1,12}):([^:\n]{1,120})$/.exec(t);
    if (!m) continue;
    valid++;
    entries.push(m[2]);
  }
  if (valid === 0 || valid / Math.max(1, nonEmpty) < 0.5) return [];
  return entries;
}

const MIRROR_RESERVED_TOP = new Set([
  'index.html',
  'manifest.json',
  'crazygames-sdk-stub.js',
]);

/**
 * Map an absolute asset URL to the entry-relative package path that the
 * game's document-relative runtime requests will resolve to locally.
 * Same-origin only; `..` segments above the entry directory clamp to the
 * package root (mirroring browser resolution at `/`).  Returns null when
 * the URL cannot be represented inside the package.
 */
function mirrorLocalPath(entryBase: string, absUrl: string): string | null {
  let base: URL;
  let abs: URL;
  try {
    base = new URL(entryBase);
    abs = new URL(absUrl);
  } catch {
    return null;
  }
  if (abs.origin !== base.origin) return null;
  if (!['http:', 'https:'].includes(abs.protocol)) return null;
  const entryDir = base.pathname.endsWith('/')
    ? base.pathname
    : base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
  const rel = path.posix.relative(entryDir || '/', abs.pathname);
  const segs = rel
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '..');
  if (segs.length === 0) return null;
  const relPath = segs.join('/');
  if (relPath.length > 200) return null;
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(relPath)) return null;
  if (MIRROR_RESERVED_TOP.has(relPath)) return null;
  try {
    return normalizePackagePath(relPath);
  } catch {
    return null;
  }
}

/**
 * Deterministic, collision-resistant local asset filename from a remote URL
 * and content type.  Uses SHA-1 of the full URL (short, collision-negligible
 * for the bounded asset set) plus a file extension derived from the
 * final-path extension or the content-type header.
 */
function assetLocalName(finalUrl: string, contentType?: string): string {
  const hash = crypto.createHash('sha1').update(finalUrl).digest('hex');
  const urlPath = (() => {
    try {
      return new URL(finalUrl).pathname;
    } catch {
      return '';
    }
  })();
  let ext = path.posix.extname(urlPath).toLowerCase();
  if (!ext || ext === '.') {
    ext = extFromContentType(contentType);
  }
  return `${hash}${ext}`;
}

function extFromContentType(ct: string | undefined): string {
  const mime = (ct ?? '').split(';')[0].trim().toLowerCase();
  if (!mime) return '';
  if (mime.includes('javascript')) return '.js';
  if (mime.includes('json')) return '.json';
  if (mime.includes('css')) return '.css';
  if (mime === 'text/html') return '.html';
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpeg';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('svg')) return '.svg';
  if (mime.includes('woff2')) return '.woff2';
  if (mime.includes('woff')) return '.woff';
  if (mime.includes('ttf')) return '.ttf';
  if (mime.includes('otf')) return '.otf';
  if (mime.includes('mp3')) return '.mp3';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('wasm')) return '.wasm';
  return '';
}

function urlPathOf(finalUrl: string): string {
  try {
    return new URL(finalUrl).pathname;
  } catch {
    return '';
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inject a CrazyGames SDK shim `<script>` tag into the HTML document.
 * The shim provides a no-op `window.Crazygames` global with common SDK
 * methods so games do not crash on startup.  If a `<head>` tag is present
 * the stub is inserted immediately after it; otherwise it is prepended.
 */
function injectSdkStub(html: string, scriptSrc: string): string {
  const tag = `<script src="${scriptSrc}"></script>`;
  const headMatch = html.match(/<head\b[^>]*>/i);
  if (headMatch) {
    return html.replace(headMatch[0], `${headMatch[0]}\n${tag}`);
  }
  // Fallback: after doctype or at document start
  const doctypeMatch = html.match(/<!doctype[^>]*>/i);
  if (doctypeMatch) {
    return html.replace(doctypeMatch[0], `${doctypeMatch[0]}\n${tag}`);
  }
  return `${tag}\n${html}`;
}

// ── CrazyGames SDK stub ─────────────────────────────────────────────────────

const SDK_STUB = `(function () {
  "use strict";
  function noop() {}
  function toPromise(v) { return Promise.resolve(v); }

  var SDK = {
    gameLoadingStart: noop,
    gameLoadingFinished: noop,
    happyTime: noop,

    addBanner: function () { return { remove: noop, onImpression: noop }; },
    removeBanner: noop,
    requestBanner: function () { return toPromise(true); },
    addVideo: function () { return toPromise({ adClosed: true }); },
    removeVideo: noop,

    hasSplash: function () { return toPromise(false); },
    playSplash: function () { return toPromise(undefined); },
    gamesplashFinished: noop,

    save: function () { return toPromise(true); },
    load: function () { return toPromise(undefined); },
    getItem: function () { return toPromise(undefined); },
    setItem: function () { return toPromise(true); },
    removeItem: function () { return toPromise(true); },

    addEventListener: noop,
    removeEventListener: noop,

    isSupportedAPI: function () { return false; },
    cfg: {},
  };

  window.Crazygames = {
    SDK: SDK,
    load: function (options) { return toPromise(options || {}); },
  };
})();`;
