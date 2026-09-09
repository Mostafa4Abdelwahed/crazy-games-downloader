import { Inject, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ImportJobEntity } from '../entities/import-job.entity';
import { CompositeDetector } from '../core/detector';
import { SecureDownloader } from '../core/downloader';
import { PackageValidator } from '../core/validator';
import { SourcePolicyService } from '../core/source-policy';
import {
  defaultImportLimits,
  GameEngineImporter,
  ImportState,
} from '../core/types';
import { UnityValidator } from '../engines/unity/unity.validator';
import { StorageFactory } from '../storage/storage.factory';
import { SourceRegistry } from '../sources/source-registry';
import { ResolvedGameSource } from '../sources/source.interface';
import {
  DiagnosticCode,
  ImportDiagnostic,
  codeOfError,
  diagnosticsOfError,
  sanitizeDetail,
} from '../core/diagnostics';

export const IMPORT_CANCELLED = 'IMPORT_CANCELLED';

/**
 * ImportWorker runs the full pipeline with isolation guardrails:
 *  - per-job timeout (Promise.race)
 *  - disk usage cap checks before/after download
 *  - no JS execution (static fetch + parse only)
 *  - cooperative cancellation via status flag
 *
 * Pipeline: fetch authorized source -> source adapter (when a platform
 * matches) -> detect engine -> engine importer -> download -> decompress ->
 * validate package -> upload to storage.
 *
 * When no source adapter handles the URL, the legacy direct-fetch path is
 * used unchanged.
 */
@Injectable()
export class ImportWorker {
  private readonly logger = new Logger(ImportWorker.name);

  constructor(
    @InjectRepository(ImportJobEntity)
    private readonly jobs: Repository<ImportJobEntity>,
    private readonly policy: SourcePolicyService,
    private readonly downloader: SecureDownloader,
    private readonly detector: CompositeDetector,
    @Inject('ENGINES') private readonly engines: GameEngineImporter[],
    private readonly validator: PackageValidator,
    private readonly unityValidator: UnityValidator,
    private readonly storageFactory: StorageFactory,
    private readonly sources: SourceRegistry,
  ) {}

  async process(jobId: string): Promise<void> {
    const limits = defaultImportLimits();
    const timeoutMs = Number(process.env.WORKER_TIMEOUT_MS ?? limits.timeoutMs);
    await this.processWithTimeout(jobId, timeoutMs);
  }

  private async processWithTimeout(
    jobId: string,
    timeoutMs: number,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Import timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([this.run(jobId), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async run(jobId: string): Promise<void> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const workRoot = process.env.IMPORT_WORK_DIR ?? './data/work';
    const workDir = path.join(path.resolve(workRoot), job.id);
    if (job.status === 'cancelled') {
      // Nothing ran here; drop the (likely empty) workspace anyway.
      await this.cleanupWorkspace(workDir);
      return;
    }
    await fs.promises.mkdir(workDir, { recursive: true });

    // Structured diagnostics for this run (M3). Streamed live by engine
    // importers via `collectDiagnostics`, sanitized + capped on persist.
    const collected: ImportDiagnostic[] = [];
    const collect = (d: ImportDiagnostic): void => {
      if (collected.length >= 200) return;
      const clean = sanitizeDetail(d) as ImportDiagnostic;
      collected.push({
        level: clean.level,
        code: String(clean.code ?? 'UNKNOWN').slice(0, 80),
        message: String(clean.message ?? '').slice(0, 500),
        ...(clean.details && typeof clean.details === 'object'
          ? { details: clean.details as Record<string, unknown> }
          : {}),
      });
    };
    try {
      // Re-validate SourcePolicy immediately before download (redirect-safe).
      this.policy.assertAllowed(job.sourceUrl);

      await this.update(jobId, {
        status: 'detecting',
        currentStep: 'fetching source',
        progress: 5,
      });
      this.throwIfCancelled(await this.get(jobId));

      // Source adapter stage: a matching platform adapter resolves the
      // authorized source into a platform-agnostic ResolvedGameSource.
      // Non-matching URLs keep the legacy direct-fetch behavior.
      let resolved: ResolvedGameSource | null = null;
      const adapter = this.sources.findAdapter(job.sourceUrl);
      if (adapter) {
        await this.update(jobId, {
          status: 'resolving',
          currentStep: `source: ${adapter.name}`,
          progress: 8,
        });
        resolved = await adapter.resolve(job.sourceUrl, {
          jobId,
          timeoutMs: 30_000,
          maxBytes: defaultImportLimits().maxDownloadBytes,
        });
        this.policy.assertAllowed(resolved.canonicalUrl);
        this.throwIfCancelled(await this.get(jobId));
      }

      // Fetch entry page (SSRF-guarded inside downloader). Adapter-resolved
      // entries point at the discovered game entry; otherwise the raw source.
      const detectTarget =
        resolved?.entryUrl ?? resolved?.gameUrl ?? job.sourceUrl;
      const entry = await this.downloader.fetchBuffer(detectTarget, {
        timeoutMs: 30_000,
      });
      // Policy: final URL after redirects must also be allowlisted.
      this.policy.assertAllowed(entry.finalUrl);
      this.throwIfCancelled(await this.get(jobId));

      const html = entry.body.toString('utf8').slice(0, 1_000_000);
      await this.update(jobId, { status: 'detecting', progress: 15 });

      // Detect engine via composite confidence scoring. Adapter-resolved
      // asset URLs are passed as filename hints; detection still decides
      // the engine — non-Unity sources are never forced into Unity.
      const detection = await this.detector.detect({
        sourceUrl: resolved?.canonicalUrl ?? job.sourceUrl,
        finalUrl: entry.finalUrl,
        html,
        contentType: entry.contentType,
        ...(resolved
          ? { fileNames: resolved.assetUrls.map(basenameOfUrl) }
          : {}),
      });
      if (detection.engine === 'unknown') {
        throw new Error(
          `Engine detection failed (confidence ${detection.confidence.toFixed(2)})`,
        );
      }
      await this.update(jobId, {
        detectedEngine: detection.engine,
        status: 'resolving',
        currentStep: `engine: ${detection.engine}`,
        progress: 25,
      });

      const engine = this.engines.find((e) => e.name === detection.engine);
      if (!engine)
        throw new Error(`No importer for engine ${detection.engine}`);

      // Engine import (downloading / extracting internally)
      await this.update(jobId, { status: 'downloading', progress: 30 });
      const pkg = await engine.import({
        jobId,
        sourceUrl: entry.finalUrl,
        workDir,
        limits: defaultImportLimits(),
        ...(resolved ? { resolvedSource: resolved } : {}),
        collectDiagnostics: (d) => collect(d),
        onProgress: async (p) => {
          const current = await this.get(jobId);
          this.throwIfCancelled(current);
          await this.update(jobId, {
            ...(p.status ? { status: p.status as ImportState } : {}),
            ...(typeof p.progress === 'number' ? { progress: p.progress } : {}),
            ...(p.currentStep ? { currentStep: p.currentStep } : {}),
            ...(typeof p.downloadedFiles === 'number'
              ? { downloadedFiles: p.downloadedFiles }
              : {}),
            ...(typeof p.totalFiles === 'number'
              ? { totalFiles: p.totalFiles }
              : {}),
            ...(p.detectedEngine ? { detectedEngine: p.detectedEngine } : {}),
          });
        },
      });
      this.throwIfCancelled(await this.get(jobId));

      // Disk cap: verify package size
      const maxDiskMb = Number(process.env.WORKER_MAX_DISK_MB ?? 2048);
      const totalBytes = pkg.files.reduce((a, f) => a + f.bytes, 0);
      if (totalBytes > maxDiskMb * 1024 * 1024) {
        throw new Error(`Package exceeds disk cap (${totalBytes} bytes)`);
      }

      // Validate
      await this.update(jobId, {
        status: 'validating',
        currentStep: 'validating package',
        progress: 80,
      });
      const generic = await this.validator.validate(pkg);
      if (!generic.valid) {
        throw new Error(`Package invalid: ${generic.errors.join('; ')}`);
      }
      if (pkg.manifest.engine === 'unity') {
        const u = await this.unityValidator.validateDetailed(pkg);
        for (const d of u.diagnostics) collect(d);
        if (!u.valid) {
          throw new Error(`Unity package invalid: ${u.errors.join('; ')}`);
        }
      }

      // Upload
      await this.update(jobId, {
        status: 'uploading',
        currentStep: 'uploading to storage',
        progress: 90,
      });
      this.throwIfCancelled(await this.get(jobId));
      const storage = this.storageFactory.create();
      const packageUrl = await storage.upload(pkg.rootPath, job.id);
      await this.update(jobId, {
        status: 'completed',
        progress: 100,
        currentStep: 'done',
        packageUrl,
        diagnostics: collected.slice(-200),
      });
      await this.appendLog(
        jobId,
        'info',
        `Import completed: ${packageUrl}`,
        'done',
      );
      // The package now lives in storage; the temp workspace is dead
      // weight on disk (often hundreds of MB). Drop it so data/work
      // never grows unbounded over many imports.
      await this.cleanupWorkspace(workDir);
    } catch (err) {
      const current = await this.jobs.findOne({ where: { id: jobId } });
      if (current?.status === 'cancelled') {
        await this.cleanupWorkspace(workDir);
        return;
      }
      for (const d of diagnosticsOfError(err)) collect(d);
      const message = (err as Error).message ?? String(err);
      // Stable failure code: first error diagnostic wins, else the error's
      // own code, else IMPORT_FAILED. Shape: {status, code, message,
      // diagnostics} without secrets (sanitized at collection).
      const firstError = collected.find((d) => d.level === 'error');
      const errorCode =
        firstError?.code ?? codeOfError(err, DiagnosticCode.IMPORT_FAILED);
      if (!firstError) {
        collect({
          level: 'error',
          code: errorCode,
          message: message.slice(0, 500),
        });
      }
      // Never log secrets: error message truncated, URLs already sanitized.
      await this.update(jobId, {
        status: 'failed',
        error: message.slice(0, 1000),
        errorCode,
        currentStep: 'failed',
        diagnostics: collected.slice(-200),
      });
      await this.appendLog(jobId, 'error', message.slice(0, 1000), 'failed');
      this.logger.error(`Import ${jobId} failed: ${message}`);
      await this.cleanupWorkspace(workDir);
    }
  }

  /**
   * Remove one job's temp workspace. Never fails the job: cleanup is a
   * courtesy, not part of the pipeline result.
   */
  private async cleanupWorkspace(workDir: string): Promise<void> {
    try {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(
        `Could not clean work dir ${workDir}: ${(err as Error).message}`,
      );
    }
  }

  private async get(jobId: string): Promise<ImportJobEntity> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) throw new Error(`Job not found: ${jobId}`);
    return job;
  }

  private throwIfCancelled(job: ImportJobEntity) {
    if (job.status === 'cancelled') {
      const e = new Error(IMPORT_CANCELLED);
      e.name = IMPORT_CANCELLED;
      throw e;
    }
  }

  private async update(
    jobId: string,
    patch: Partial<ImportJobEntity>,
  ): Promise<void> {
    await this.jobs.update({ id: jobId }, patch);
  }

  private async appendLog(
    jobId: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    step?: string,
  ): Promise<void> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) return;
    const logs = [...(job.logs ?? [])];
    logs.push({ at: new Date().toISOString(), level, message, step });
    await this.jobs.update({ id: jobId }, { logs: logs.slice(-500) });
  }
}

/** Basename hint for detection; never throws on odd inputs. */
function basenameOfUrl(absUrl: string): string {
  try {
    const parts = new URL(absUrl).pathname.split('/').filter(Boolean);
    return parts.pop() ?? absUrl;
  } catch {
    return absUrl;
  }
}
