/**
 * Opt-in real-world validation (M3).
 *
 * Usage:
 *   REAL_TEST_SOURCE_URL=https://<authorized-game-url> npm run validate:real
 *
 * Requires explicit authorization to import and redistribute the tested game.
 * The URL must ALSO satisfy SourcePolicy (SOURCE_ALLOWED_HOSTS) and all
 * SSRF guards. Nothing is uploaded anywhere — the package stays local and
 * the report is printed to stdout. Exits 0 on runtime success, 1 on
 * validation failure, 2 when misconfigured/skipped.
 *
 * Normal CI never runs this: it is opt-in and needs a live authorized URL.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SourcePolicyService } from '../src/game-importer/core/source-policy';
import { SecureDownloader } from '../src/game-importer/core/downloader';
import { CompositeDetector } from '../src/game-importer/core/detector';
import { PackageValidator } from '../src/game-importer/core/validator';
import {
  defaultImportLimits,
  GamePackage,
} from '../src/game-importer/core/types';
import { UnityDetector } from '../src/game-importer/engines/unity/unity.detector';
import { UnityLoaderParser } from '../src/game-importer/engines/unity/unity.loader-parser';
import { UnityAssetResolver } from '../src/game-importer/engines/unity/unity.asset-resolver';
import { UnityConfigDiscovery } from '../src/game-importer/engines/unity/unity.config-discovery';
import { UnityDecompressor } from '../src/game-importer/engines/unity/unity.decompressor';
import { UnityValidator } from '../src/game-importer/engines/unity/unity.validator';
import { UnityImporter } from '../src/game-importer/engines/unity/unity.importer';
import { GenericHtml5Importer } from '../src/game-importer/engines/generic-html5.importer';
import { SourceRegistry } from '../src/game-importer/sources/source-registry';
import { AuthorizedSourcePolicy } from '../src/game-importer/sources/authorized-source-policy';
import { CrazyGamesParser } from '../src/game-importer/sources/crazygames/crazygames.parser';
import { CrazyGamesSourceAdapter } from '../src/game-importer/sources/crazygames/crazygames.source';
import { LocalPackageServer } from '../src/game-importer/runtime/local-package-server';
import { PlaywrightRuntimeValidator } from '../src/game-importer/runtime/playwright-runtime-validator';

function step(label: string): void {
  // eslint-disable-next-line no-console
  console.log(`[validate:real] ${label}`);
}

async function main(): Promise<void> {
  const sourceUrl = (process.env.REAL_TEST_SOURCE_URL ?? '').trim();
  if (!sourceUrl) {
    // eslint-disable-next-line no-console
    console.log(
      '[validate:real] skipped: REAL_TEST_SOURCE_URL is not configured. ' +
        'Set it to an explicitly authorized game URL to run real validation.',
    );
    process.exitCode = 2;
    return;
  }

  // Manual wiring (same classes the Nest module uses — no container needed).
  const policy = new SourcePolicyService();
  const downloader = new SecureDownloader();
  const authorized = new AuthorizedSourcePolicy(policy);
  const crazyParser = new CrazyGamesParser();
  const crazyAdapter = new CrazyGamesSourceAdapter(
    crazyParser,
    downloader,
    authorized,
  );
  const registry = new SourceRegistry([crazyAdapter]);
  const unityLoaderParser = new UnityLoaderParser();
  const unityImporter = new UnityImporter(
    new UnityDetector(),
    downloader,
    unityLoaderParser,
    new UnityAssetResolver(),
    new UnityDecompressor(),
    new UnityConfigDiscovery(unityLoaderParser, policy),
    policy,
  );
  const genericImporter = new GenericHtml5Importer();
  const detector = new CompositeDetector([unityImporter, genericImporter]);
  const packageValidator = new PackageValidator();
  const unityValidator = new UnityValidator();
  const runtimeValidator = new PlaywrightRuntimeValidator(
    new LocalPackageServer(),
  );

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-real-'));
  const report: Record<string, unknown> = { sourceUrl, workDir };
  const fail = (stage: string, err: unknown): never => {
    report.stage = stage;
    report.success = false;
    report.error = err instanceof Error ? err.message.slice(0, 1000) : String(err);
    report.code =
      (err as { code?: string })?.code ?? 'IMPORT_FAILED';
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    throw new Error('reported');
  };

  try {
    step('checking SourcePolicy (fail-closed without allowlisting)');
    policy.assertAllowed(sourceUrl);

    step('resolving source adapter');
    const adapter = registry.findAdapter(sourceUrl);
    report.adapter = adapter?.name ?? '(direct fetch)';
    let resolved: Awaited<ReturnType<typeof crazyAdapter.resolve>> | null =
      null;
    if (adapter) {
      resolved = await adapter.resolve(sourceUrl, { timeoutMs: 30_000 });
      report.resolved = {
        canonicalUrl: resolved.canonicalUrl,
        entryUrl: resolved.entryUrl,
        assetCount: resolved.assetUrls.length,
        title: resolved.metadata?.title,
      };
    }

    step('fetching entry + detecting engine');
    const target = resolved?.entryUrl ?? resolved?.gameUrl ?? sourceUrl;
    const entry = await downloader.fetchBuffer(target, { timeoutMs: 30_000 });
    policy.assertAllowed(entry.finalUrl);
    const html = entry.body.toString('utf8').slice(0, 1_000_000);
    const detection = await detector.detect({
      sourceUrl,
      finalUrl: entry.finalUrl,
      html,
      contentType: entry.contentType,
    });
    report.detection = {
      engine: detection.engine,
      confidence: detection.confidence,
    };
    if (detection.engine !== 'unity') {
      throw new Error(
        `Real validation supports Unity builds; detected: ${detection.engine}`,
      );
    }

    step('importing Unity package');
    const jobDir = path.join(workDir, 'job');
    const pkg: GamePackage = await unityImporter.import({
      jobId: 'validate-real',
      sourceUrl: entry.finalUrl,
      workDir: jobDir,
      limits: defaultImportLimits(),
      ...(resolved ? { resolvedSource: resolved } : {}),
    });
    report.package = {
      rootPath: pkg.rootPath,
      files: pkg.files.map((f) => f.path),
      manifest: pkg.manifest,
    };

    step('validating package');
    const generic = await packageValidator.validate(pkg);
    if (!generic.valid) {
      throw new Error(`Package invalid: ${generic.errors.join('; ')}`);
    }
    const unity = await unityValidator.validateDetailed(pkg);
    report.packageValidation = {
      valid: unity.valid,
      diagnostics: unity.diagnostics,
    };
    if (!unity.valid) {
      throw new Error(`Unity package invalid: ${unity.errors.join('; ')}`);
    }

    step('running Playwright runtime validation (local HTTP only)');
    const runtime = await runtimeValidator.validate(pkg, {
      timeoutMs: Number(
        process.env.RUNTIME_VALIDATION_TIMEOUT_MS ?? 120_000,
      ),
    });
    report.runtime = runtime;
    report.success = runtime.success;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = runtime.success ? 0 : 1;
  } catch (err) {
    if (err instanceof Error && err.message === 'reported') return;
    fail('pipeline', err);
  }
}

void main();
