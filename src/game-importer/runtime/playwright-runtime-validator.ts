import { Injectable } from '@nestjs/common';
import { chromium } from 'playwright-core';
import { GamePackage } from '../core/types';
import {
  DiagnosticCode,
  DiagnosticCollector,
  safeUrlForLog,
} from '../core/diagnostics';
import { LocalPackageServer } from './local-package-server';
import {
  EXPLICIT_READY_FLAGS,
  classifyAssetKind,
  evaluateInitSignals,
  isExtensionNoise,
  isStreamingAssetsRequestUrl,
  matchesFmodFailure,
  matchesInitConsoleMessage,
} from './init-signals';
import {
  ExternalRuntimeRequest,
  FailedRuntimeRequest,
  InitSnapshot,
  RuntimeAssetKind,
  RuntimeValidationOptions,
  RuntimeValidationResult,
} from './runtime.types';
import { RuntimeValidator } from './runtime-validator.interface';

const DEFAULT_TIMEOUT_MS = Number(
  process.env.RUNTIME_VALIDATION_TIMEOUT_MS ?? 30_000,
);

const DEFAULT_SETTLE_MS = Number(
  process.env.RUNTIME_VALIDATION_SETTLE_MS ?? 5_000,
);

/** Upper bound for a single DOM/flag probe (a wedged renderer must not stall the run). */
const PROBE_TIMEOUT_MS = Number(
  process.env.RUNTIME_VALIDATION_PROBE_TIMEOUT_MS ?? 10_000,
);

/** Upper bound for browser/context teardown (wedged renderers, slow GL). */
const CLOSE_TIMEOUT_MS = 15_000;

/** Resolve `p` unless it exceeds `ms` (never rejects; teardown safety). */
function withCloseTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
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

const EXPECTED_ARTIFACT_MIME: Partial<Record<RuntimeAssetKind, string[]>> = {
  loader: ['text/javascript', 'application/javascript'],
  framework: ['text/javascript', 'application/javascript'],
  wasm: ['application/wasm'],
  data: ['application/octet-stream'],
};

/**
 * Same-origin auto-requests issued by browser chrome itself (never by the
 * game). Missing them says nothing about package health, so they are
 * excluded from failed-asset tracking. Deliberately tiny: everything else
 * same-origin that fails still fails the run.
 */
const BENIGN_LOCAL_PATHS = new Set(['/favicon.ico']);

function localPathname(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function isBenignLocalRequest(url: string): boolean {
  return BENIGN_LOCAL_PATHS.has(localPathname(url));
}

/**
 * Playwright runtime validator (M3).
 *
 * 1. Serves ONLY the generated package dir on 127.0.0.1 (ephemeral port).
 * 2. Opens the entry file in headless Chromium.
 * 3. Captures console messages, page errors, failed requests.
 * 4. Polls multi-signal Unity initialization until timeout.
 * 5. Returns a structured {@link RuntimeValidationResult}.
 *
 * Trust model: the imported game is UNTRUSTED third-party code. It runs
 * exclusively inside the browser sandbox (a separate OS process with no
 * Node.js, no require(), no env, no DB/Redis, no filesystem beyond what
 * the confined local server exposes). No imported code is ever eval()'d
 * in Node. External requests are recorded (and optionally blocked), never
 * proxied or bypassed.
 */
@Injectable()
export class PlaywrightRuntimeValidator implements RuntimeValidator {
  readonly name = 'playwright';

  constructor(
    private readonly servers: LocalPackageServer = new LocalPackageServer(),
  ) {}

  async validate(
    pkg: GamePackage,
    options: RuntimeValidationOptions = {},
  ): Promise<RuntimeValidationResult> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = options.pollIntervalMs ?? 250;
    const settleMs = Math.max(0, options.settleMs ?? DEFAULT_SETTLE_MS);
    const collector = new DiagnosticCollector();
    const entryFile =
      options.entryFile ?? pkg.manifest?.entryFile ?? 'index.html';

    const server = await this.servers.serve(pkg.rootPath);
    const serverOrigin = new URL(server.url).origin;
    const target = new URL(entryFile, server.url).toString();

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: FailedRuntimeRequest[] = [];
    const externalRequests: ExternalRuntimeRequest[] = [];
    const seenExternal = new Set<string>();
    const loadedKinds = new Set<RuntimeAssetKind>();
    const attemptedKinds = new Set<RuntimeAssetKind>();
    const requiredFailed: FailedRuntimeRequest[] = [];
    /**
     * Every failed SAME-ORIGIN (packaged) request, any kind: Unity boots
     * BEFORE it pulls StreamingAssets banks, so a boot-only verdict hides
     * incomplete packages. Any entry here fails the run.
     */
    const failedLocal: FailedRuntimeRequest[] = [];
    let fmodFailed = false;
    let consolePatternMatched = false;

    const isLocal = (url: string): boolean => {
      try {
        return new URL(url).origin === serverOrigin;
      } catch {
        return false;
      }
    };
    const recordFailed = (entry: FailedRuntimeRequest): void => {
      failedRequests.push(entry);
      failedLocal.push(entry);
      if (classifyAssetKind(entry.url) !== 'other') {
        requiredFailed.push(entry);
        collector.error(
          DiagnosticCode.MISSING_ASSET,
          `Required runtime asset failed to load: ${safeUrlForLog(entry.url)}`,
          {
            status: entry.status,
            errorText: (entry.errorText ?? '').slice(0, 200),
          },
        );
      } else if (isStreamingAssetsRequestUrl(entry.url)) {
        collector.error(
          DiagnosticCode.UNITY_RUNTIME_ASSET_MISSING,
          `Packaged StreamingAssets dependency failed to load: ${safeUrlForLog(entry.url)}`,
          {
            status: entry.status,
            errorText: (entry.errorText ?? '').slice(0, 200),
          },
        );
      } else {
        collector.error(
          DiagnosticCode.UNITY_RUNTIME_ASSET_REQUEST_FAILED,
          `Packaged asset request failed: ${safeUrlForLog(entry.url)}`,
          {
            status: entry.status,
            errorText: (entry.errorText ?? '').slice(0, 200),
          },
        );
      }
    };
    const recordFmodFailure = (origin: string, text: string): void => {
      if (fmodFailed) return;
      fmodFailed = true;
      collector.error(
        DiagnosticCode.UNITY_RUNTIME_ASSET_MISSING,
        `Unity audio/bank initialization failed (${origin}); package likely misses StreamingAssets banks`,
        { detail: text.slice(0, 200) },
      );
    };

    let browser: import('playwright-core').Browser | null = null;
    try {
      browser = await chromium.launch({
        headless: true,
        ...((options.executablePath ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH)
          ? {
              executablePath:
                options.executablePath ??
                process.env.PLAYWRIGHT_EXECUTABLE_PATH!,
            }
          : {}),
      });
      const context = await browser.newContext();
      if (options.blockExternal) {
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (!isLocal(url) && /^https?:/i.test(url)) {
            const key = `${route.request().method()} ${url}`;
            if (!seenExternal.has(key)) {
              seenExternal.add(key);
              externalRequests.push({
                url: safeUrlForLog(url),
                method: route.request().method(),
              });
            }
            collector.warning(
              DiagnosticCode.EXTERNAL_REFERENCE,
              `Blocked external request: ${safeUrlForLog(url)}`,
            );
            void route.abort();
            return;
          }
          void route.continue();
        });
      }
      const page = await context.newPage();

      page.on('console', (msg) => {
        const type = msg.type();
        const text = msg.text().slice(0, 1000);
        if (isExtensionNoise(text)) return;
        if (type === 'error') {
          consoleErrors.push(text);
          collector.warning(
            DiagnosticCode.RUNTIME_CONSOLE_ERROR,
            `Console error: ${text.slice(0, 300)}`,
          );
          if (matchesFmodFailure(text)) {
            recordFmodFailure('console', text);
          }
        }
        if (matchesInitConsoleMessage(text)) consolePatternMatched = true;
        // FMOD failures often surface as warnings/logs, not errors.
        if (type !== 'error' && matchesFmodFailure(text)) {
          recordFmodFailure('console', text);
        }
      });
      page.on('pageerror', (err) => {
        const text = String(err?.message ?? err).slice(0, 1000);
        if (isExtensionNoise(text)) return;
        pageErrors.push(text);
        collector.error(
          DiagnosticCode.RUNTIME_ERROR,
          `Page error: ${text.slice(0, 300)}`,
        );
        if (matchesFmodFailure(text)) {
          recordFmodFailure('pageerror', text);
        }
      });
      page.on('requestfailed', (req) => {
        const url = req.url();
        if (!isLocal(url)) {
          const key = `${req.method()} ${url}`;
          if (!seenExternal.has(key)) {
            seenExternal.add(key);
            externalRequests.push({
              url: safeUrlForLog(url),
              method: req.method(),
            });
          }
          collector.warning(
            DiagnosticCode.EXTERNAL_REFERENCE,
            `External request failed: ${safeUrlForLog(url)}`,
          );
          return;
        }
        const failure = req.failure()?.errorText ?? 'request failed';
        if (isBenignLocalRequest(url)) return;
        recordFailed({
          url: safeUrlForLog(url),
          method: req.method(),
          errorText: failure.slice(0, 200),
        });
      });
      page.on('response', (res) => {
        const url = res.url();
        if (!isLocal(url)) {
          const key = `${res.request().method()} ${url}`;
          if (!seenExternal.has(key)) {
            seenExternal.add(key);
            externalRequests.push({
              url: safeUrlForLog(url),
              method: res.request().method(),
            });
          }
          collector.warning(
            DiagnosticCode.EXTERNAL_REFERENCE,
            `External request observed: ${safeUrlForLog(url)}`,
            { status: res.status() },
          );
          return;
        }
        const kind = classifyAssetKind(url);
        if (kind === 'other') {
          // Non-artifact packaged requests (StreamingAssets banks, json,
          // images, audio): 2xx is fine, but ANY failure means an
          // incomplete package — never ignore it. Browser-chrome
          // auto-requests (favicon) are the only exclusion.
          if (isBenignLocalRequest(url)) return;
          const status = res.status();
          if (status >= 400) {
            recordFailed({ url: safeUrlForLog(url), status });
          }
          return;
        }
        attemptedKinds.add(kind);
        const status = res.status();
        if (status >= 200 && status < 300) {
          loadedKinds.add(kind);
          // MIME sanity for runtime-critical artifacts (warn only: some
          // origins serve odd types that still work via fetch).
          const expected = EXPECTED_ARTIFACT_MIME[kind];
          const actual = (res.headers()['content-type'] ?? '')
            .split(';')[0]
            .trim()
            .toLowerCase();
          if (expected && actual && !expected.includes(actual)) {
            collector.warning(
              DiagnosticCode.INVALID_CONTENT_TYPE,
              `Unexpected content type for ${kind}: ${actual || '(none)'}`,
              { url: safeUrlForLog(url) },
            );
          }
        } else {
          recordFailed({ url: safeUrlForLog(url), status });
        }
      });

      const deadline = Date.now() + timeoutMs;
      const hasFatal = (): boolean =>
        pageErrors.length > 0 ||
        requiredFailed.length > 0 ||
        failedLocal.length > 0 ||
        fmodFailed;
      let evaluation = evaluateInitSignals(
        this.snapshot(
          false,
          false,
          loadedKinds,
          attemptedKinds,
          consolePatternMatched,
          pageErrors,
          requiredFailed,
          failedLocal,
          fmodFailed,
        ),
      );
      // Navigate first (collects console/network evidence), then poll.
      const navError = await page
        .goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        .then(() => null)
        .catch((e: Error) => e);
      if (navError) {
        collector.error(
          DiagnosticCode.NETWORK_FAILURE,
          `Navigation failed: ${navError.message.slice(0, 300)}`,
        );
      }

      // Boot-vs-healthy: Unity initializes BEFORE it pulls StreamingAssets
      // banks, so a first `initialized` verdict must NOT settle the run.
      // Keep observing for `settleMs` so late 404s/FMOD failures flip the
      // verdict to RUNTIME_ERROR instead of a premature RUNTIME_OK.
      //
      // Probe evidence is STICKY (monotonic latch): a fully booted game can
      // saturate the renderer main thread so hard that evaluate stalls and
      // times out (observed on Traffic Rider post-boot). A timed-out probe
      // reports absence, which must never retract an earlier positive —
      // canvas/flags don't disappear while the run stays failure-free.
      let settled = false;
      let initializedAt: number | null = null;
      let seenCanvas = false;
      let seenExplicit = false;
      while (Date.now() < deadline && !settled) {
        const probed = await this.probePage(page);
        seenCanvas = seenCanvas || probed.canvas;
        seenExplicit = seenExplicit || probed.explicit;
        evaluation = evaluateInitSignals(
          this.snapshot(
            seenCanvas,
            seenExplicit,
            loadedKinds,
            attemptedKinds,
            consolePatternMatched,
            pageErrors,
            requiredFailed,
            failedLocal,
            fmodFailed,
          ),
        );
        if (hasFatal()) {
          // Fail fast on page errors / failed packaged assets / FMOD
          // failures (fail closed).
          settled = true;
        } else if (evaluation.initialized) {
          if (initializedAt === null) initializedAt = Date.now();
          if (Date.now() - initializedAt >= settleMs) settled = true;
          else await new Promise((r) => setTimeout(r, pollMs));
        } else await new Promise((r) => setTimeout(r, pollMs));
      }
      const durationMs = Date.now() - startedAt;
      // Re-evaluate once after the settle window: late failures collected
      // during settle must be reflected even if the last poll predates them.
      // Sticky probe evidence carries over (a stalled final probe reports
      // absence, which must not retract earlier positives).
      const finalProbe = await this.probePage(page);
      seenCanvas = seenCanvas || finalProbe.canvas;
      seenExplicit = seenExplicit || finalProbe.explicit;
      evaluation = evaluateInitSignals(
        this.snapshot(
          seenCanvas,
          seenExplicit,
          loadedKinds,
          attemptedKinds,
          consolePatternMatched,
          pageErrors,
          requiredFailed,
          failedLocal,
          fmodFailed,
        ),
      );
      const unityInitialized = evaluation.initialized;
      if (unityInitialized) {
        collector.info(
          DiagnosticCode.RUNTIME_OK,
          'Unity runtime initialized in local browser',
          { signals: evaluation.matchedSignals },
        );
      } else if (hasFatal()) {
        collector.error(
          DiagnosticCode.RUNTIME_ERROR,
          'Unity runtime failed: page errors, failed packaged assets, or audio/bank initialization failure',
          { signals: evaluation.missingSignals },
        );
      } else {
        collector.error(
          DiagnosticCode.RUNTIME_TIMEOUT,
          'Unity runtime did not initialize within the configured timeout',
          {
            timeoutMs,
            signals: evaluation.missingSignals,
          },
        );
      }

      const success =
        unityInitialized &&
        pageErrors.length === 0 &&
        requiredFailed.length === 0 &&
        failedLocal.length === 0 &&
        !fmodFailed;
      const streamingAssetsFailures = failedLocal.filter((f) =>
        isStreamingAssetsRequestUrl(f.url),
      );
      return {
        success,
        code: success
          ? DiagnosticCode.RUNTIME_OK
          : hasFatal()
            ? DiagnosticCode.RUNTIME_ERROR
            : DiagnosticCode.RUNTIME_TIMEOUT,
        durationMs,
        consoleErrors,
        pageErrors,
        failedRequests,
        externalRequests,
        unityInitialized,
        signals: evaluation,
        diagnostics: collector.all(),
        failedGameAssets: [...failedLocal],
        streamingAssetsFailures,
        fmodFailed,
      };
    } finally {
      await withCloseTimeout(
        browser?.close().catch(() => undefined) ?? Promise.resolve(),
        CLOSE_TIMEOUT_MS,
      );
      await withCloseTimeout(
        server.close().catch(() => undefined),
        5_000,
      );
    }
  }

  private snapshot(
    canvas: boolean,
    explicit: boolean,
    loaded: Set<RuntimeAssetKind>,
    attempted: Set<RuntimeAssetKind>,
    consolePattern: boolean,
    fatalErrors: string[],
    failedRequired: FailedRuntimeRequest[],
    failedLocal: FailedRuntimeRequest[] = [],
    fmodFailed = false,
  ): InitSnapshot {
    return {
      canvasPresent: canvas,
      loadedKinds: [...loaded],
      attemptedKinds: [...attempted],
      explicitReady: explicit,
      consolePatternMatched: consolePattern,
      fatalErrors: [...fatalErrors],
      failedRequired: [...failedRequired],
      failedLocal: [...failedLocal],
      fmodFailed,
    };
  }

  /** Static DOM/flag probe — reads state, never invokes game code. */
  private async probePage(page: import('playwright-core').Page): Promise<{
    canvas: boolean;
    explicit: boolean;
  }> {
    // Real game pages can wedge the renderer main thread (observed: a
    // Unity/FMOD bank-load failure stalls evaluate indefinitely), so the
    // probe is hard-bounded — the deadline-driven poll loop must keep
    // moving on console/network evidence alone.
    const probe = page
      .evaluate(
        ({ flags }: { flags: string[] }) => {
          const doc = (globalThis as unknown as { document: Document })
            .document;
          const canvas = doc.querySelector(
            'canvas#unity-canvas, canvas.unity-canvas, canvas',
          );
          const g = globalThis as unknown as Record<string, unknown>;
          return {
            canvas: Boolean(canvas),
            explicit: flags.some((f) => {
              const v = g[f];
              if (f === 'unityInstance') return v != null;
              return v === true;
            }),
          };
        },
        { flags: [...EXPLICIT_READY_FLAGS] },
      )
      .then(
        (r) => r,
        () => ({ canvas: false, explicit: false }),
      );
    const timeout = new Promise<{ canvas: boolean; explicit: boolean }>(
      (resolve) => {
        const timer = setTimeout(
          () => resolve({ canvas: false, explicit: false }),
          PROBE_TIMEOUT_MS,
        );
        const unref = (timer as unknown as { unref?: () => void } | undefined)
          ?.unref;
        if (typeof unref === 'function') unref.call(timer);
      },
    );
    try {
      return await Promise.race([probe, timeout]);
    } catch {
      return { canvas: false, explicit: false };
    }
  }
}
