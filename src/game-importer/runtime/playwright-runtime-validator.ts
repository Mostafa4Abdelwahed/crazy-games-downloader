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

const EXPECTED_ARTIFACT_MIME: Partial<Record<RuntimeAssetKind, string[]>> = {
  loader: ['text/javascript', 'application/javascript'],
  framework: ['text/javascript', 'application/javascript'],
  wasm: ['application/wasm'],
  data: ['application/octet-stream'],
};

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
      } else {
        collector.error(
          DiagnosticCode.NETWORK_FAILURE,
          `Request failed: ${safeUrlForLog(entry.url)}`,
          {
            status: entry.status,
            errorText: (entry.errorText ?? '').slice(0, 200),
          },
        );
      }
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
        if (type === 'error') {
          consoleErrors.push(text);
          collector.warning(
            DiagnosticCode.RUNTIME_CONSOLE_ERROR,
            `Console error: ${text.slice(0, 300)}`,
          );
        }
        if (matchesInitConsoleMessage(text)) consolePatternMatched = true;
      });
      page.on('pageerror', (err) => {
        const text = String(err?.message ?? err).slice(0, 1000);
        pageErrors.push(text);
        collector.error(
          DiagnosticCode.RUNTIME_ERROR,
          `Page error: ${text.slice(0, 300)}`,
        );
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
        if (kind === 'other') return;
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
      let evaluation = evaluateInitSignals(
        this.snapshot(
          false,
          false,
          loadedKinds,
          attemptedKinds,
          consolePatternMatched,
          pageErrors,
          requiredFailed,
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

      let settled = false;
      while (Date.now() < deadline && !settled) {
        const probed = await this.probePage(page);
        evaluation = evaluateInitSignals(
          this.snapshot(
            probed.canvas,
            probed.explicit,
            loadedKinds,
            attemptedKinds,
            consolePatternMatched,
            pageErrors,
            requiredFailed,
          ),
        );
        if (
          evaluation.initialized ||
          pageErrors.length > 0 ||
          requiredFailed.length > 0
        ) {
          // Fail fast on page errors / required-asset failures (fail closed);
          // otherwise poll until the timeout for late initialization.
          settled = true;
        } else await new Promise((r) => setTimeout(r, pollMs));
      }

      const durationMs = Date.now() - startedAt;
      const unityInitialized = evaluation.initialized;
      if (unityInitialized) {
        collector.info(
          DiagnosticCode.RUNTIME_OK,
          'Unity runtime initialized in local browser',
          { signals: evaluation.matchedSignals },
        );
      } else if (pageErrors.length > 0 || requiredFailed.length > 0) {
        collector.error(
          DiagnosticCode.RUNTIME_ERROR,
          'Unity runtime failed: page errors or required assets failed',
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
        requiredFailed.length === 0;
      return {
        success,
        code: success
          ? DiagnosticCode.RUNTIME_OK
          : pageErrors.length > 0 || requiredFailed.length > 0
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
      };
    } finally {
      await browser?.close().catch(() => undefined);
      await server.close().catch(() => undefined);
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
  ): InitSnapshot {
    return {
      canvasPresent: canvas,
      loadedKinds: [...loaded],
      attemptedKinds: [...attempted],
      explicitReady: explicit,
      consolePatternMatched: consolePattern,
      fatalErrors: [...fatalErrors],
      failedRequired: [...failedRequired],
    };
  }

  /** Static DOM/flag probe — reads state, never invokes game code. */
  private async probePage(page: import('playwright-core').Page): Promise<{
    canvas: boolean;
    explicit: boolean;
  }> {
    try {
      return await page.evaluate(
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
      );
    } catch {
      return { canvas: false, explicit: false };
    }
  }
}
