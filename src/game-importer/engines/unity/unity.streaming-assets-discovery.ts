import { Injectable } from '@nestjs/common';
import { SecureDownloader } from '../../core/downloader';
import { SourcePolicyService } from '../../core/source-policy';
import { LocalPackageServer } from '../../runtime/local-package-server';
import {
  DiagnosticCode,
  DiagnosticCollector,
  ImportDiagnostic,
  safeUrlForLog,
} from '../../core/diagnostics';
import { normalizePackagePath } from '../../core/path-utils';
import {
  STREAMING_ASSETS_SEGMENT,
  StreamingAssetsDiscoveryOptions,
  defaultStreamingAssetsOptions,
  hasStreamingAssetsSegment,
  isStreamingAssetsUrl,
  normalizeStreamingPrefix,
  streamingBaseUrl,
  toRemoteStreamingAssetsUrl,
  toStreamingAssetsPackagePath,
} from './unity.streaming-assets';
import {
  catalogPackagePath,
  extractCatalogInternalIds,
  addressablesPackagePath,
  rewriteCatalogIds,
} from './unity.addressables';

export interface StreamingRuntimeObservation {
  /** Absolute http(s) URLs observed under the StreamingAssets prefix. */
  urls: string[];
  diagnostics: ImportDiagnostic[];
}

export interface StreamingDownloadResult {
  /** Package-relative paths written under StreamingAssets/... */
  files: Array<{ path: string; bytes: number; sourceUrl: string }>;
  totalBytes: number;
  limitReached: boolean;
  diagnostics: ImportDiagnostic[];
}

/** Quiet window after the last NEW observation before stopping early. */
const LOCAL_OBSERVE_QUIET_MS = 8_000;

/** Resolve `p` unless it exceeds `ms` (never rejects; teardown safety). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), ms);
    const unref = (timer as unknown as { unref?: () => void } | undefined)
      ?.unref;
    if (typeof unref === 'function') unref.call(timer);
  });
  return Promise.race([p, gate]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Bounded Unity StreamingAssets dependency discovery + download (generic).
 *
 * Sources of truth (no filename hardcoding, no directory crawling):
 *  1. Runtime network observation: the authorized game entry is loaded in
 *     an isolated headless browser and only requests under the Unity
 *     `streamingAssetsUrl` prefix are recorded.
 *  2. Static references: quoted `StreamingAssets/...` paths in already
 *     downloaded text (loader/framework), resolved against the config base.
 *
 * Every candidate must pass SourcePolicy (requested AND final URL) and
 * SSRF guards (enforced in SecureDownloader). Ads/analytics/trackers can
 * never enter: only URLs under the StreamingAssets prefix are eligible.
 */
@Injectable()
export class UnityStreamingAssetsDiscovery {
  constructor(
    private readonly downloader: SecureDownloader,
    private readonly policy: SourcePolicyService,
  ) {}

  options(): StreamingAssetsDiscoveryOptions {
    return defaultStreamingAssetsOptions();
  }

  /**
   * Observe the authorized remote game entry in an isolated browser and
   * record StreamingAssets requests. Bounded by `discoveryTimeoutMs` and
   * `maxFiles`; failures degrade to static-only discovery (warning, never
   * fatal) so offline CI without a browser keeps working.
   */
  async collectRuntimeUrls(input: {
    entryUrl: string;
    configBaseUrl: string;
    streamingAssetsUrl: string;
    timeoutMs?: number;
    maxFiles?: number;
    executablePath?: string;
  }): Promise<StreamingRuntimeObservation> {
    const collector = new DiagnosticCollector();
    const opts = defaultStreamingAssetsOptions();
    const timeoutMs = input.timeoutMs ?? opts.discoveryTimeoutMs;
    const maxFiles = input.maxFiles ?? opts.maxFiles;
    const prefix = normalizeStreamingPrefix(input.streamingAssetsUrl);
    collector.info(
      DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_STARTED,
      'StreamingAssets runtime discovery started',
      {
        ...(prefix ? { prefix } : {}),
        url: safeUrlForLog(input.entryUrl),
      },
    );

    // Policy gate before launching any browser traffic.
    try {
      this.policy.assertAllowed(input.entryUrl);
    } catch (err) {
      collector.warning(
        DiagnosticCode.EXTERNAL_REFERENCE,
        'Skipping StreamingAssets runtime discovery: entry outside source policy',
        { reason: (err as Error).message.slice(0, 200) },
      );
      return { urls: [], diagnostics: collector.all() };
    }

    let playwright: typeof import('playwright-core') | null = null;
    try {
      playwright = await import('playwright-core');
    } catch (err) {
      collector.warning(
        DiagnosticCode.NETWORK_FAILURE,
        'Skipping StreamingAssets runtime discovery: browser runtime unavailable',
        { reason: (err as Error).message.slice(0, 200) },
      );
      return { urls: [], diagnostics: collector.all() };
    }

    const base = {
      streamingAssetsUrl: input.streamingAssetsUrl,
      configBaseUrl: input.configBaseUrl,
    };
    const found = new Map<string, string>(); // packagePath -> absolute url
    let limitReached = false;
    let browser: import('playwright-core').Browser | null = null;
    try {
      browser = await playwright.chromium.launch({
        headless: true,
        ...((input.executablePath ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH)
          ? {
              executablePath:
                input.executablePath ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH!,
            }
          : {}),
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      const onRequest = (req: import('playwright-core').Request): void => {
        if (found.size >= maxFiles) {
          limitReached = true;
          return;
        }
        const url = req.url();
        if (!/^https?:/i.test(url)) return;
        // Prefix-scoped match first; segment fallback covers CDN-split
        // layouts where the signal base differs from the load location.
        // Still restricted to StreamingAssets paths + source policy.
        if (!isStreamingAssetsUrl(url, base) && !hasStreamingAssetsSegment(url))
          return;
        // Source-policy gate per observed URL (ads/trackers can never
        // match the prefix, but hosts are still allowlisted explicitly).
        if (!this.policy.isAllowed(url).allowed) return;
        const pkgPath = toStreamingAssetsPackagePath(url, base);
        if (!pkgPath) return;
        if (!found.has(pkgPath)) {
          found.set(pkgPath, url.split('#')[0]);
          collector.info(
            DiagnosticCode.UNITY_STREAMING_ASSET_DISCOVERED,
            `StreamingAssets dependency observed: ${pkgPath}`,
            { url: safeUrlForLog(url) },
          );
        }
      };
      page.on('request', onRequest);
      try {
        await page.goto(input.entryUrl, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(timeoutMs, 60_000),
        });
        // Observation window: keep the page alive so post-boot FMOD bank
        // fetches fire. Bounded — never an unlimited crawl.
        const settle = Math.min(Math.max(timeoutMs - 5_000, 5_000), 30_000);
        await page
          .waitForLoadState('networkidle', { timeout: settle })
          .catch(() => undefined);
        await new Promise((r) => setTimeout(r, Math.min(5_000, settle)));
      } catch (err) {
        collector.warning(
          DiagnosticCode.NETWORK_FAILURE,
          'StreamingAssets runtime observation ended early',
          { reason: (err as Error).message.slice(0, 200) },
        );
      } finally {
        page.removeListener('request', onRequest);
        await context.close().catch(() => undefined);
      }
    } catch (err) {
      collector.warning(
        DiagnosticCode.NETWORK_FAILURE,
        'StreamingAssets runtime discovery unavailable; continuing with static signals',
        { reason: (err as Error).message.slice(0, 200) },
      );
    } finally {
      await browser?.close().catch(() => undefined);
    }

    if (limitReached) {
      collector.warning(
        DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_LIMIT_REACHED,
        `StreamingAssets file-count cap reached (${maxFiles}); additional dependencies ignored`,
        { maxFiles },
      );
    }
    collector.info(
      DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_COMPLETED,
      `StreamingAssets runtime discovery completed: ${found.size} file(s)`,
      { count: found.size },
    );
    return {
      urls: [...found.values()],
      diagnostics: collector.all(),
    };
  }

  /**
   * Observe the provisional LOCAL package in an isolated browser and
   * record StreamingAssets requests the booting game makes. This is the
   * primary runtime signal: portal pages routinely refuse to boot under
   * automation (connection-gated loaders, anti-bot), while the packaged
   * game boots headless and requests its banks from the local server
   * (which 404s until the files are packaged — every observed path is a
   * dependency by construction). Bounded in time and file count; browser
   * absence degrades to a warning (static/remote signals still apply).
   */
  async observeLocalPaths(input: {
    pkgDir: string;
    entryFile?: string;
    timeoutMs?: number;
    maxFiles?: number;
    knownPaths?: Set<string>;
    executablePath?: string;
  }): Promise<{ paths: string[]; diagnostics: ImportDiagnostic[] }> {
    const collector = new DiagnosticCollector();
    const timeoutMs = Math.min(
      input.timeoutMs ??
        Number(process.env.UNITY_STREAMING_ASSETS_LOCAL_TIMEOUT_MS ?? 30_000),
      120_000,
    );
    const maxFiles = input.maxFiles ?? defaultStreamingAssetsOptions().maxFiles;
    const known = input.knownPaths ?? new Set<string>();
    collector.info(
      DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_STARTED,
      'StreamingAssets local-package observation started',
    );

    let playwright: typeof import('playwright-core') | null = null;
    try {
      playwright = await import('playwright-core');
    } catch (err) {
      collector.warning(
        DiagnosticCode.NETWORK_FAILURE,
        'Skipping StreamingAssets local observation: browser runtime unavailable',
        { reason: (err as Error).message.slice(0, 200) },
      );
      return { paths: [], diagnostics: collector.all() };
    }

    const found = new Map<string, string>();
    let limitReached = false;
    let firstNewAt: number | null = null;
    let server: Awaited<ReturnType<LocalPackageServer['serve']>> | null = null;
    let browser: import('playwright-core').Browser | null = null;
    try {
      server = await new LocalPackageServer().serve(input.pkgDir);
      const origin = new URL(server.url).origin;
      const target = new URL(
        input.entryFile ?? 'index.html',
        server.url,
      ).toString();
      browser = await playwright.chromium.launch({
        headless: true,
        ...((input.executablePath ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH)
          ? {
              executablePath:
                input.executablePath ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH!,
            }
          : {}),
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('request', (req) => {
        const url = req.url();
        let sameOrigin = false;
        try {
          sameOrigin = new URL(url).origin === origin;
        } catch {
          return;
        }
        if (!sameOrigin) return;
        const pkgPath = toStreamingAssetsPackagePath(url, {
          streamingAssetsUrl: '',
          configBaseUrl: server?.url ?? '',
        });
        if (!pkgPath || found.has(pkgPath)) return;
        if (found.size >= maxFiles) {
          limitReached = true;
          return;
        }
        found.set(pkgPath, url.split('#')[0]);
        if (!known.has(pkgPath)) {
          if (firstNewAt === null) firstNewAt = Date.now();
          collector.info(
            DiagnosticCode.UNITY_STREAMING_ASSET_DISCOVERED,
            `StreamingAssets dependency observed locally: ${pkgPath}`,
            { url: safeUrlForLog(url) },
          );
        }
      });
      await page
        .goto(target, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(timeoutMs, 60_000),
        })
        .catch((err: Error) => {
          collector.warning(
            DiagnosticCode.NETWORK_FAILURE,
            'Local-package observation navigation ended early',
            { reason: err.message.slice(0, 200) },
          );
        });
      // Bounded observation window with early exit: once new paths stop
      // appearing for the quiet window, the boot's bank requests are in.
      const deadline = Date.now() + timeoutMs;
      let lastCount = -1;
      let quietSince: number | null = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        if (firstNewAt !== null && Date.now() - firstNewAt >= timeoutMs) break;
        if (found.size === lastCount) {
          if (quietSince === null) quietSince = Date.now();
          if (
            firstNewAt !== null &&
            Date.now() - quietSince >= LOCAL_OBSERVE_QUIET_MS
          ) {
            break;
          }
        } else {
          lastCount = found.size;
          quietSince = null;
        }
      }
      await withTimeout(
        context.close().catch(() => undefined),
        10_000,
      );
    } catch (err) {
      collector.warning(
        DiagnosticCode.NETWORK_FAILURE,
        'StreamingAssets local observation unavailable; continuing with known signals',
        { reason: (err as Error).message.slice(0, 200) },
      );
    } finally {
      await withTimeout(
        browser?.close().catch(() => undefined) ?? Promise.resolve(),
        15_000,
      );
      await withTimeout(
        server?.close().catch(() => undefined) ?? Promise.resolve(),
        5_000,
      );
    }
    if (limitReached) {
      collector.warning(
        DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_LIMIT_REACHED,
        `StreamingAssets file-count cap reached (${maxFiles}); additional dependencies ignored`,
        { maxFiles },
      );
    }
    collector.info(
      DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_COMPLETED,
      `StreamingAssets local observation completed: ${found.size} file(s)`,
      { count: found.size },
    );
    return { paths: [...found.keys()], diagnostics: collector.all() };
  }

  /**
   * Download an Addressables content tree (generic M3.3).
   *
   * Probes the candidate catalog URLs in order (policy-gated, bounded);
   * the first response that parses as an Addressables catalog wins. A
   * missing/unparsable catalog is NORMAL for non-Addressables games and
   * simply yields no files. Entries are downloaded through the same
   * policy/SSRF-guarded pipeline and caps as bank dependencies; the
   * packaged catalog is rewritten so packaged IDs resolve locally.
   */
  async downloadAddressablesTree(input: {
    candidateCatalogUrls: string[];
    writeFile: (packagePath: string, bytes: Buffer) => Promise<void> | void;
    timeoutMs?: number;
    maxFiles?: number;
    maxTotalBytes?: number;
    onEvent?: (d: ImportDiagnostic) => void;
  }): Promise<StreamingDownloadResult> {
    const collector = new DiagnosticCollector();
    const emit = (d: ImportDiagnostic): void => {
      collector.add(d.level, d.code, d.message, d.details);
      try {
        input.onEvent?.(d);
      } catch {
        /* never break downloads */
      }
    };
    const opts = defaultStreamingAssetsOptions();
    const timeoutMs = input.timeoutMs ?? opts.requestTimeoutMs;
    const maxFiles = input.maxFiles ?? opts.maxFiles;
    const maxTotalBytes = input.maxTotalBytes ?? opts.maxTotalBytes;
    const empty: StreamingDownloadResult = {
      files: [],
      totalBytes: 0,
      limitReached: false,
      diagnostics: collector.all(),
    };
    emit({
      level: 'info',
      code: DiagnosticCode.UNITY_ADDRESSABLES_DISCOVERY_STARTED,
      message: `Probing ${input.candidateCatalogUrls.length} Addressables catalog candidate(s)`,
      details: { candidates: input.candidateCatalogUrls.length },
    });

    let catalogUrl: string | null = null;
    let catalogText: string | null = null;
    for (const url of input.candidateCatalogUrls) {
      if (!/^https?:/i.test(url) || !this.policy.isAllowed(url).allowed) {
        continue;
      }
      try {
        const res = await this.downloader.fetchBuffer(url, {
          timeoutMs: Math.min(timeoutMs, 60_000),
          maxBytes: Math.min(5_000_000, maxTotalBytes),
        });
        this.policy.assertAllowed(res.finalUrl);
        const text = res.body.toString('utf8');
        const parsed: unknown = JSON.parse(text);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !Array.isArray(
            (parsed as Record<string, unknown>)['m_ResourceLocators'],
          )
        ) {
          continue;
        }
        catalogUrl = res.finalUrl;
        catalogText = text;
        break;
      } catch {
        continue;
      }
    }
    if (!catalogUrl || catalogText === null) {
      emit({
        level: 'info',
        code: DiagnosticCode.UNITY_ADDRESSABLES_CATALOG_MISSING,
        message:
          'No Addressables catalog reachable; skipping Addressables tree (normal for non-Addressables games)',
      });
      return { ...empty, diagnostics: collector.all() };
    }

    const ids = extractCatalogInternalIds(JSON.parse(catalogText));
    emit({
      level: 'info',
      code: DiagnosticCode.UNITY_ADDRESSABLES_CATALOG_FOUND,
      message: `Addressables catalog found with ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}`,
      details: {
        url: safeUrlForLog(catalogUrl),
        entries: ids.length,
      },
    });

    const files: StreamingDownloadResult['files'] = [];
    let totalBytes = 0;
    let limitReached = false;
    const packagedById = new Map<string, string>();
    // Reserve one slot + catalog bytes for the rewritten catalog itself.
    for (const id of ids) {
      if (files.length + 1 >= maxFiles || totalBytes >= maxTotalBytes) {
        limitReached = true;
        break;
      }
      let abs: string;
      try {
        abs = new URL(id, catalogUrl).toString();
      } catch {
        continue;
      }
      if (!/^https?:/i.test(abs) || !this.policy.isAllowed(abs).allowed) {
        continue;
      }
      const pkgPath = addressablesPackagePath(abs);
      if (!pkgPath || packagedById.has(id)) {
        if (!pkgPath) {
          emit({
            level: 'warning',
            code: DiagnosticCode.EXTERNAL_REFERENCE,
            message: `Skipping Addressables entry outside StreamingAssets: ${id.slice(0, 120)}`,
          });
        }
        continue;
      }
      emit({
        level: 'info',
        code: DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_STARTED,
        message: `Downloading Addressables entry: ${pkgPath}`,
        details: { url: safeUrlForLog(abs) },
      });
      try {
        this.policy.assertAllowed(abs);
        const remaining = maxTotalBytes - totalBytes;
        const res = await this.downloader.fetchBuffer(abs, {
          timeoutMs: Math.min(timeoutMs, 60_000),
          maxBytes: Math.min(remaining, maxTotalBytes),
        });
        this.policy.assertAllowed(res.finalUrl);
        if (totalBytes + res.body.length > maxTotalBytes) {
          limitReached = true;
          break;
        }
        await input.writeFile(pkgPath, res.body);
        totalBytes += res.body.length;
        files.push({
          path: pkgPath,
          bytes: res.body.length,
          sourceUrl: res.finalUrl,
        });
        packagedById.set(id, pkgPath);
        emit({
          level: 'info',
          code: DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_COMPLETED,
          message: `Downloaded Addressables entry: ${pkgPath}`,
          details: {
            url: safeUrlForLog(res.finalUrl),
            bytes: res.body.length,
          },
        });
      } catch (err) {
        emit({
          level: 'warning',
          code: DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_FAILED,
          message: `Addressables entry download failed: ${pkgPath}`,
          details: { reason: (err as Error).message.slice(0, 300) },
        });
      }
    }

    // Write the (possibly ID-rewritten) catalog itself.
    const catalogPkgPath = catalogPackagePath(catalogUrl);
    const rewritten =
      rewriteCatalogIds(catalogText, catalogPkgPath, packagedById) ??
      catalogText;
    const catalogBytes = Buffer.from(rewritten, 'utf8');
    if (!limitReached && totalBytes + catalogBytes.length <= maxTotalBytes) {
      try {
        await input.writeFile(catalogPkgPath, catalogBytes);
        totalBytes += catalogBytes.length;
        files.unshift({
          path: catalogPkgPath,
          bytes: catalogBytes.length,
          sourceUrl: catalogUrl,
        });
      } catch (err) {
        emit({
          level: 'warning',
          code: DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_FAILED,
          message: `Addressables catalog write failed: ${catalogPkgPath}`,
          details: { reason: (err as Error).message.slice(0, 300) },
        });
      }
    } else {
      limitReached = true;
    }
    if (limitReached) {
      emit({
        level: 'warning',
        code: DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_LIMIT_REACHED,
        message: 'Addressables budget reached; content tree may be incomplete',
        details: { files: files.length, totalBytes },
      });
    }
    emit({
      level: 'info',
      code: DiagnosticCode.UNITY_ADDRESSABLES_DISCOVERY_COMPLETED,
      message: `Addressables discovery completed: ${files.length} file(s), ${totalBytes} bytes`,
      details: { count: files.length, totalBytes },
    });
    return {
      files,
      totalBytes,
      limitReached,
      diagnostics: collector.all(),
    };
  }

  /**
   * Resolve package-relative static refs against the remote base and merge
   * them with observed absolute URLs. Policy-gated + deduped + capped.
   *
   * `streamingAssetsUrl` selects the match scope: a concrete prefix matches
   * only under that base, while an empty value falls back to matching any
   * URL carrying the `StreamingAssets` segment (used when the build exposed
   * no explicit signal). `staticResolveBase` anchors static ref → remote
   * URL resolution and defaults to `streamingAssetsUrl` (or the conventional
   * relative `StreamingAssets` prefix when that is empty).
   */
  resolveCandidates(input: {
    observedUrls: string[];
    staticPaths: string[];
    streamingAssetsUrl: string;
    configBaseUrl: string;
    maxFiles?: number;
    staticResolveBase?: string;
  }): { urls: Array<{ url: string; path: string }>; limitReached: boolean } {
    const maxFiles = input.maxFiles ?? defaultStreamingAssetsOptions().maxFiles;
    const base = {
      streamingAssetsUrl: input.streamingAssetsUrl,
      configBaseUrl: input.configBaseUrl,
    };
    const merged = new Map<string, string>(); // path -> url
    let limitReached = false;
    const staticBase = input.staticResolveBase ?? input.streamingAssetsUrl;
    const push = (absUrl: string): void => {
      if (merged.size >= maxFiles) {
        limitReached = true;
        return;
      }
      if (!/^https?:/i.test(absUrl)) return;
      if (!this.policy.isAllowed(absUrl).allowed) return;
      if (!isStreamingAssetsUrl(absUrl, base)) return;
      const pkgPath = toStreamingAssetsPackagePath(absUrl, base);
      if (!pkgPath || merged.has(pkgPath)) return;
      merged.set(pkgPath, absUrl);
    };
    for (const u of input.observedUrls ?? []) push(u);
    if (merged.size < maxFiles) {
      for (const rel of input.staticPaths ?? []) {
        if (merged.size >= maxFiles) {
          limitReached = true;
          break;
        }
        let safe: string;
        try {
          safe = normalizePackagePath(rel);
        } catch {
          continue;
        }
        if (
          !safe.startsWith(`${STREAMING_ASSETS_SEGMENT}/`) ||
          merged.has(safe)
        ) {
          continue;
        }
        const abs = toRemoteStreamingAssetsUrl(safe, {
          streamingAssetsUrl: staticBase || STREAMING_ASSETS_SEGMENT,
          configBaseUrl: input.configBaseUrl,
        });
        if (!abs || !this.policy.isAllowed(abs).allowed) continue;
        merged.set(safe, abs);
      }
    }
    void streamingBaseUrl;
    return {
      urls: [...merged.entries()].map(([path, url]) => ({ url, path })),
      limitReached,
    };
  }

  /**
   * Download resolved candidates through the policy/SSRF-guarded
   * downloader. Returns the package-relative files written. Enforces the
   * total-bytes cap; failures are reported per-file (warning) without
   * aborting the remaining set.
   */
  async downloadAll(
    candidates: Array<{ url: string; path: string }>,
    input: {
      timeoutMs?: number;
      maxTotalBytes?: number;
      writeFile: (packagePath: string, bytes: Buffer) => Promise<void> | void;
      onEvent?: (d: ImportDiagnostic) => void;
    },
  ): Promise<StreamingDownloadResult> {
    const collector = new DiagnosticCollector();
    const opts = defaultStreamingAssetsOptions();
    const timeoutMs = input.timeoutMs ?? opts.requestTimeoutMs;
    const maxTotalBytes = input.maxTotalBytes ?? opts.maxTotalBytes;
    const files: StreamingDownloadResult['files'] = [];
    let totalBytes = 0;
    let limitReached = false;

    for (const c of candidates) {
      if (files.length >= opts.maxFiles || totalBytes >= maxTotalBytes) {
        limitReached = true;
        break;
      }
      let safe: string;
      try {
        safe = normalizePackagePath(c.path);
      } catch {
        continue;
      }
      if (!safe.startsWith(`${STREAMING_ASSETS_SEGMENT}/`)) continue;
      const emit = (d: ImportDiagnostic): void => {
        collector.add(d.level, d.code, d.message, d.details);
        try {
          input.onEvent?.(d);
        } catch {
          /* never break downloads */
        }
      };
      emit({
        level: 'info',
        code: DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_STARTED,
        message: `Downloading StreamingAssets dependency: ${safe}`,
        details: { url: safeUrlForLog(c.url) },
      });
      try {
        this.policy.assertAllowed(c.url);
      } catch (err) {
        emit({
          level: 'warning',
          code: DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_FAILED,
          message: `Skipping StreamingAssets dependency outside source policy: ${safe}`,
          details: { reason: (err as Error).message.slice(0, 200) },
        });
        continue;
      }
      try {
        const remaining = maxTotalBytes - totalBytes;
        const res = await this.downloader.fetchBuffer(c.url, {
          timeoutMs: Math.min(timeoutMs, 60_000),
          maxBytes: Math.min(remaining, opts.maxTotalBytes),
        });
        this.policy.assertAllowed(res.finalUrl);
        if (totalBytes + res.body.length > maxTotalBytes) {
          limitReached = true;
          emit({
            level: 'warning',
            code: DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_LIMIT_REACHED,
            message: `StreamingAssets byte cap reached; skipping ${safe}`,
            details: { maxTotalBytes },
          });
          break;
        }
        await input.writeFile(safe, res.body);
        totalBytes += res.body.length;
        files.push({
          path: safe,
          bytes: res.body.length,
          sourceUrl: res.finalUrl,
        });
        emit({
          level: 'info',
          code: DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_COMPLETED,
          message: `Downloaded StreamingAssets dependency: ${safe}`,
          details: {
            url: safeUrlForLog(res.finalUrl),
            bytes: res.body.length,
          },
        });
      } catch (err) {
        emit({
          level: 'warning',
          code: DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_FAILED,
          message: `StreamingAssets download failed: ${safe}`,
          details: { reason: (err as Error).message.slice(0, 300) },
        });
      }
    }

    if (limitReached) {
      collector.warning(
        DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_LIMIT_REACHED,
        'StreamingAssets download cap reached; package may be incomplete',
        { files: files.length, totalBytes },
      );
    }
    return {
      files,
      totalBytes,
      limitReached,
      diagnostics: collector.all(),
    };
  }
}
