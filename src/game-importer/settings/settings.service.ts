import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Repository } from 'typeorm';
import { ImportJobEntity } from '../entities/import-job.entity';
import { GameImportsService } from '../game-imports.service';
import { dirUsage } from '../storage/disk-usage';

/**
 * Read-only view of every project-wide runtime setting (environment
 * driven) shown on the Settings page. Values reflect the environment the
 * server process was started with; they are documentation, not editable
 * state — changing an env var requires a restart by design.
 */
export interface SettingsView {
  server: { port: string };
  database: { driver: 'sqlite' | 'postgres'; sqlitePath: string };
  queue: {
    driver: 'memory' | 'bullmq';
    redisUrl: boolean;
    concurrency: string;
    jobTimeoutMs: string;
  };
  limits: {
    maxDownloadBytes: string;
    maxExtractedBytes: string;
    workerTimeoutMs: string;
    workerMaxMemoryMb: string;
    workerMaxDiskMb: string;
  };
  paths: { workDir: string; storageDriver: string; storageRoot: string };
  security: {
    allowedHosts: string[];
    allowAnyHttps: boolean;
    blockPrivateNetworks: boolean;
    cloudMetadataBlock: boolean;
  };
  runtime: {
    validationTimeoutMs: string;
    playwrightExecutablePath: string | null;
    streamingAssetsRuntimeDiscovery: boolean;
    streamingAssetsLocalDiscovery: boolean;
    python: string;
  };
  stats: {
    jobs: number;
    packages: number;
    workDirs: number;
    packagesBytes: number;
    workBytes: number;
  };
}

const ON = (v: string | undefined, fallback = false): boolean =>
  (v ?? (fallback ? 'true' : 'false')).toLowerCase() === 'true';

/**
 * Central settings + maintenance operations for the management console.
 *
 * - `view()` renders the read-only settings snapshot (no secrets — env
 *   values like REDIS_URL are shown as booleans, never inlined).
 * - Danger-zone actions wipe operational data. Each requires an explicit
 *   client confirmation phrase; the service re-checks it server-side so
 *   the API cannot be tricked into deleting without intent.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @InjectRepository(ImportJobEntity)
    private readonly jobs: Repository<ImportJobEntity>,
    private readonly games: GameImportsService,
  ) {}

  /** Confirmation phrase required by every destructive action. */
  static readonly CONFIRM_PHRASE = 'DELETE';

  async view(): Promise<SettingsView> {
    const [workDir, storageRoot] = [this.workRoot(), this.storageRoot()];
    return {
      server: { port: process.env.PORT ?? '3000' },
      database: {
        driver: process.env.DATABASE_URL ? 'postgres' : 'sqlite',
        sqlitePath: process.env.SQLITE_PATH ?? './data/app.sqlite',
      },
      queue: {
        driver: this.queueDriver(),
        redisUrl: Boolean(process.env.REDIS_URL),
        concurrency: process.env.IMPORT_CONCURRENCY ?? '1',
        jobTimeoutMs: process.env.IMPORT_JOB_TIMEOUT_MS ?? '600000',
      },
      limits: {
        maxDownloadBytes:
          process.env.IMPORT_MAX_DOWNLOAD_BYTES ?? String(512 * 1024 * 1024),
        maxExtractedBytes:
          process.env.IMPORT_MAX_EXTRACTED_BYTES ?? String(1024 * 1024 * 1024),
        workerTimeoutMs: process.env.WORKER_TIMEOUT_MS ?? '600000',
        workerMaxMemoryMb: process.env.WORKER_MAX_MEMORY_MB ?? '1024',
        workerMaxDiskMb: process.env.WORKER_MAX_DISK_MB ?? '2048',
      },
      paths: {
        workDir,
        storageDriver: process.env.STORAGE_DRIVER ?? 'local',
        storageRoot,
      },
      stats: await this.stats(),
      security: {
        allowedHosts: (process.env.SOURCE_ALLOWED_HOSTS ?? '')
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean),
        allowAnyHttps: ON(process.env.ALLOW_ANY_HTTPS),
        blockPrivateNetworks: ON(process.env.BLOCK_PRIVATE_NETWORKS, true),
        cloudMetadataBlock: ON(process.env.CLOUD_METADATA_BLOCK, true),
      },
      runtime: {
        validationTimeoutMs:
          process.env.RUNTIME_VALIDATION_TIMEOUT_MS ?? '30000',
        playwrightExecutablePath:
          process.env.PLAYWRIGHT_EXECUTABLE_PATH || null,
        streamingAssetsRuntimeDiscovery: ON(
          process.env.UNITY_STREAMING_ASSETS_RUNTIME_DISCOVERY,
          true,
        ),
        streamingAssetsLocalDiscovery: ON(
          process.env.UNITY_STREAMING_ASSETS_LOCAL_DISCOVERY,
          true,
        ),
        python:
          process.env.PYTHON ??
          (process.platform === 'win32' ? 'python' : 'python3'),
      },
    };
  }

  /**
   * Wipe ALL operational data: every job row, every work directory and
   * every stored package. Irreversible; requires the confirmation phrase.
   * Running game servers are stopped first so locked package dirs can
   * actually be deleted.
   */
  async resetAll(confirm: string): Promise<{
    clearedJobs: number;
    clearedWork: number;
    clearedPackages: number;
    stoppedServers: number;
    failedPackages: string[];
  }> {
    this.assertConfirmed(confirm);
    const clearedJobs = await this.clearJobsInternal();
    const clearedWork = await this.clearWorkInternal();
    const pkgs = await this.clearPackagesInternal();
    this.logger.log(
      `Settings reset-all: ${clearedJobs} jobs, ${clearedWork} work dirs, ` +
        `${pkgs.cleared} packages (servers stopped: ${pkgs.stoppedServers})`,
    );
    return {
      clearedJobs,
      clearedWork,
      clearedPackages: pkgs.cleared,
      stoppedServers: pkgs.stoppedServers,
      failedPackages: pkgs.failed,
    };
  }

  /** Delete every job row (packages/work dirs on disk are kept). */
  async clearJobs(confirm: string): Promise<{ cleared: number }> {
    this.assertConfirmed(confirm);
    return { cleared: await this.clearJobsInternal() };
  }

  /** Delete every temporary work directory (in-flight imports may fail). */
  async clearWork(confirm: string): Promise<{ cleared: number }> {
    this.assertConfirmed(confirm);
    return { cleared: (await this.rmDirChildren(this.workRoot())).cleared };
  }

  /**
   * Delete every stored package directory (runnable games are removed).
   * Running game servers are stopped first — on Windows a live
   * `python -m http.server` locks its package dir (EBUSY) and deletion
   * would otherwise fail. Entries that still fail are reported in
   * `failed` instead of being silently swallowed.
   */
  async clearPackages(confirm: string): Promise<{
    cleared: number;
    failed: string[];
    stoppedServers: number;
  }> {
    this.assertConfirmed(confirm);
    return this.clearPackagesInternal();
  }

  private assertConfirmed(confirm: string): void {
    if (
      (confirm ?? '').trim().toUpperCase() !== SettingsService.CONFIRM_PHRASE
    ) {
      throw new BadRequestException(
        `Type ${SettingsService.CONFIRM_PHRASE} to confirm this destructive action.`,
      );
    }
  }

  private async clearJobsInternal(): Promise<number> {
    const rows = await this.jobs.find({ select: ['id'] });
    if (rows.length === 0) return 0;
    await this.jobs.remove(rows);
    return rows.length;
  }

  private async clearWorkInternal(): Promise<number> {
    return (await this.rmDirChildren(this.workRoot())).cleared;
  }

  private async clearPackagesInternal(): Promise<{
    cleared: number;
    failed: string[];
    stoppedServers: number;
  }> {
    let stoppedServers = 0;
    try {
      stoppedServers = (await this.games.stopAllRuns()).stopped;
    } catch (err) {
      this.logger.warn(
        `Could not stop running game servers: ${(err as Error).message}`,
      );
    }
    const { cleared, failed } = await this.rmDirChildren(this.storageRoot());
    for (const f of failed) {
      this.logger.error(
        `Could not delete package dir during clear: ${f} ` +
          `(stop its game server / close handles on it, then retry)`,
      );
    }
    return { cleared, failed, stoppedServers };
  }

  /**
   * Remove every child entry under `root`. Returns the cleared count plus
   * the names that could NOT be removed (e.g. locked by a live process).
   */
  private async rmDirChildren(
    root: string,
  ): Promise<{ cleared: number; failed: string[] }> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return { cleared: 0, failed: [] }; // missing root -> nothing to clear
    }
    let cleared = 0;
    const failed: string[] = [];
    for (const e of entries) {
      const abs = path.resolve(root, e.name);
      try {
        await fs.promises.rm(abs, { recursive: true, force: true });
        cleared += 1;
      } catch (err) {
        failed.push(e.name);
        this.logger.warn(`Could not remove ${abs}: ${(err as Error).message}`);
      }
    }
    return { cleared, failed };
  }

  /** Job/package/work counts + on-disk usage for the stats card. */
  private async stats(): Promise<SettingsView['stats']> {
    let jobsCount = 0;
    try {
      jobsCount = await this.jobs.count();
    } catch {
      jobsCount = 0;
    }
    const storageRoot = this.storageRoot();
    const workRoot = this.workRoot();
    const [packages, workDirs, packagesUsage, workUsage] = await Promise.all([
      this.countChildren(storageRoot),
      this.countChildren(workRoot),
      dirUsage(storageRoot),
      dirUsage(workRoot),
    ]);
    return {
      jobs: jobsCount,
      packages,
      workDirs,
      packagesBytes: packagesUsage.bytes,
      workBytes: workUsage.bytes,
    };
  }

  private async countChildren(root: string): Promise<number> {
    try {
      const entries = await fs.promises.readdir(root);
      return entries.length;
    } catch {
      return 0;
    }
  }

  private workRoot(): string {
    return path.resolve(process.env.IMPORT_WORK_DIR ?? './data/work');
  }

  private storageRoot(): string {
    return path.resolve(process.env.STORAGE_LOCAL_ROOT ?? './data/packages');
  }

  private queueDriver(): 'memory' | 'bullmq' {
    const hasRedis = Boolean(process.env.REDIS_URL);
    const want = process.env.QUEUE_DRIVER ?? (hasRedis ? 'bullmq' : 'memory');
    return want === 'bullmq' && hasRedis ? 'bullmq' : 'memory';
  }
}
