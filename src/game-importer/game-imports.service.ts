import {
  Injectable,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
  Logger,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, Like, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { ImportJobEntity } from './entities/import-job.entity';
import { RunServerEntity } from './entities/run-server.entity';
import { SourcePolicyService } from './core/source-policy';
import { ImportQueueService } from './queue/import.queue';
import { ImportJob, ImportJobLogEntry, ImportState } from './core/types';
import { DiagnosticLevel, ImportDiagnostic } from './core/diagnostics';
import { SourceRegistry } from './sources/source-registry';
import { dirUsage } from './storage/disk-usage';
import { FoldersService } from './folders/folders.service';
import {
  ListedGamesResult,
  SourceAccessRestrictedError,
  SourceRedirectedError,
} from './sources/source.interface';

const LEVELS: DiagnosticLevel[] = ['info', 'warning', 'error'];

/** DI token for the function that opens a URL in the default browser. */
export const GAME_BROWSER_OPENER = Symbol('GAME_BROWSER_OPENER');

/** Valid `status` filter values for the jobs listing (console). */
const VALID_STATUSES = new Set<string>([
  'queued',
  'detecting',
  'resolving',
  'downloading',
  'extracting',
  'validating',
  'uploading',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Normalize a game URL so equivalent submissions deduplicate:
 * lowercase origin, strip default ports, drop fragment and trailing slash.
 * Keeps the path/query so genuinely different games stay distinct.
 */
export function normalizeSourceKey(sourceUrl: string): string {
  const trimmed = sourceUrl.trim();
  try {
    const u = new URL(trimmed);
    if (
      (u.protocol === 'http:' && u.port === '80') ||
      (u.protocol === 'https:' && u.port === '443')
    ) {
      u.port = '';
    }
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * A game discovered on a listing page, annotated for the console UI:
 * `key` is the dedup identity and `already` tells whether an import row
 * already exists for it (with its current status when known).
 */
export interface DiscoveredGameView {
  url: string;
  key: string;
  title: string;
  thumbnail?: string;
  already: boolean;
  status?: string;
}

/**
 * Lightweight job row for the management console table. Heavy fields
 * (logs, diagnostics, error, packageUrl) are fetched separately via
 * `GET /game-imports/:id` only when a job is actually inspected.
 */
export interface ImportJobSummary {
  id: string;
  seq: number | null;
  sourceUrl: string;
  status: ImportState;
  progress: number;
  updatedAt: string;
  /** Owning folder (null = ungrouped); needed for folder-preserving retry. */
  folderId: string | null;
}

/**
 * Paginated job listing for the management console: one page of jobs plus
 * enough metadata to render Prev/Next and "Page X of Y" controls.
 */
export interface ImportJobPage {
  items: ImportJobSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Rehydrate stored JSON diagnostics into typed ImportDiagnostics. */
function toDiagnostics(
  stored: ImportJobEntity['diagnostics'],
): ImportDiagnostic[] | null {
  if (!stored) return null;
  return stored.map((d) => ({
    level: LEVELS.includes(d.level as DiagnosticLevel)
      ? (d.level as DiagnosticLevel)
      : 'info',
    code: String(d.code ?? 'UNKNOWN'),
    message: String(d.message ?? ''),
    ...(d.details && typeof d.details === 'object'
      ? { details: d.details as Record<string, unknown> }
      : {}),
  }));
}

/** A locally served package (from a "Start local server" click). */
export interface RunningGameView {
  url: string;
  port: number;
}

interface RunServerEntry {
  child: ReturnType<typeof spawn>;
  root: string;
  url: string;
  port: number;
  browser?: ReturnType<typeof spawn>;
}

/** Grab an unused loopback TCP port (best-effort; releases it immediately). */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** True when a pid exists right now (signal 0 never delivers anything). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort kill by pid (no handle needed). Returns whether it sent. */
function killPid(pid: number): boolean {
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/** True when something on loopback currently accepts `port`. */
function isPortOpen(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v: boolean) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

/** Resolve a `python` executable from the environment, cross-platform. */
function pythonExecutable(): string {
  return process.platform === 'win32'
    ? 'python'
    : (process.env.PYTHON ?? 'python3');
}

/** A local HTTP server started for one job (the "try this game" flow). */
export interface LaunchLocalServerResult {
  url: string;
  port: number;
  child: ReturnType<typeof spawn>;
}
export type LocalServerLauncher = (
  root: string,
  port: number,
) => Promise<LaunchLocalServerResult>;
/** DI token for the factory that starts the local package HTTP server. */
export const GAME_LOCAL_SERVER = Symbol('GAME_LOCAL_SERVER');

/** Poll a URL until it answers, so Start opens a ready server. */
async function waitForServer(url: string, attempts = 20): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok || res.status >= 400) return;
    } catch {
      /* not ready yet */
    }
    await sleep(200);
  }
  throw new BadRequestException(`Local server did not become ready at ${url}.`);
}

/**
 * The faithful launcher: runs `python -m http.server` rooted at the package
 * dir — exactly the `cd <dir>` + python flow the operator uses by hand — and
 * opens it on loopback so the served page behaves identically to the
 * manually-run command.
 */
export const launchPythonHttpServer: LocalServerLauncher = async (
  root,
  port,
) => {
  const python = pythonExecutable();
  const child = spawn(
    python,
    ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
    { cwd: root, stdio: 'ignore', windowsHide: true },
  );
  const url = `http://localhost:${port}/`;
  await waitForServer(url);
  return { url, port, child };
};

/**
 * Open a URL in the default browser, detached from the app process so it
 * outlives the request. Cross-platform: Windows `start`, macOS `open`,
 * Linux `xdg-open`. Guarded — never throws; failures surface as a muted
 * note rather than a broken import.
 */
export function openBrowser(url: string): ReturnType<typeof spawn> | null {
  try {
    const cmd =
      process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : process.platform === 'darwin'
          ? { file: 'open', args: [url] }
          : { file: 'xdg-open', args: [url] };
    const child = spawn(cmd.file, cmd.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}

function toJob(e: ImportJobEntity): ImportJob {
  return {
    id: e.id,
    seq: e.seq ?? null,
    sourceUrl: e.sourceUrl,
    status: e.status,
    progress: e.progress,
    detectedEngine: e.detectedEngine,
    downloadedFiles: e.downloadedFiles,
    totalFiles: e.totalFiles,
    currentStep: e.currentStep,
    error: e.error,
    errorCode: e.errorCode ?? null,
    diagnostics: toDiagnostics(e.diagnostics),
    packageUrl: e.packageUrl,
    packageBytes: null,
    packageFiles: null,
    folderId: e.folderId ?? null,
    createdAt: e.createdAt?.toISOString?.() ?? new Date().toISOString(),
    updatedAt: e.updatedAt?.toISOString?.() ?? new Date().toISOString(),
  };
}

/**
 * Lightweight job row for the console table. Heavy payloads (logs,
 * diagnostics, error, packageUrl) are deliberately omitted — a page of
 * N rows must not drag all their details along; the console fetches them
 * per-job via `GET /game-imports/:id` when a row is actually inspected.
 */
function toJobSummary(e: ImportJobEntity): ImportJobSummary {
  return {
    id: e.id,
    seq: e.seq ?? null,
    sourceUrl: e.sourceUrl,
    status: e.status,
    progress: e.progress,
    updatedAt: e.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    folderId: e.folderId ?? null,
  };
}

@Injectable()
export class GameImportsService implements OnModuleInit {
  private readonly logger = new Logger(GameImportsService.name);

  constructor(
    @InjectRepository(ImportJobEntity)
    private readonly jobs: Repository<ImportJobEntity>,
    private readonly policy: SourcePolicyService,
    private readonly queue: ImportQueueService,
    private readonly sources: SourceRegistry,
    private readonly folders: FoldersService,
    @Inject(GAME_BROWSER_OPENER)
    private readonly openInBrowser: (
      url: string,
    ) => ReturnType<typeof spawn> | null = openBrowser,
    @Inject(GAME_LOCAL_SERVER)
    private readonly launchServer: LocalServerLauncher = launchPythonHttpServer,
    @InjectRepository(RunServerEntity)
    private readonly servers: Repository<RunServerEntity>,
  ) {}

  private readonly running = new Map<string, RunServerEntry>();

  /**
   * Next human-friendly sequential job number (#1, #2, …). Unique enough
   * for console display; a rare race would just retry on the unique
   * index, so serialize via a single in-process promise chain.
   */
  private seqChain: Promise<number> = Promise.resolve(0);
  private nextSeq(): Promise<number> {
    this.seqChain = this.seqChain.then(async (prev) => {
      const last = await this.jobs
        .createQueryBuilder('j')
        .select('MAX(j.seq)', 'max')
        .getRawOne();
      const max = Number(last?.max ?? 0);
      return Math.max(max, prev) + 1;
    });
    return this.seqChain;
  }

  /**
   * Backfill `sourceKey` for rows created before dedup existed (their
   * column defaulted to `''`), and `seq` for rows created before the
   * human-friendly job numbering existed (NULL) — legacy rows get
   * numbers in creation order so the console shows #1, #2, … for them.
   */
  async onModuleInit(): Promise<void> {
    try {
      const missing = await this.jobs.find({
        where: { sourceKey: '' },
        order: { updatedAt: 'DESC' },
      });
      if (missing.length) {
        for (const e of missing) e.sourceKey = normalizeSourceKey(e.sourceUrl);
        await this.jobs.save(missing);
        this.logger.log(
          `Backfilled sourceKey for ${missing.length} import row(s)`,
        );
      }
    } catch (err) {
      this.logger.warn(`sourceKey backfill skipped: ${(err as Error).message}`);
    }
    try {
      const unnumbered = await this.jobs.find({
        where: { seq: null as unknown as number },
        order: { createdAt: 'ASC' },
      });
      if (unnumbered.length) {
        const last = await this.jobs
          .createQueryBuilder('j')
          .select('MAX(j.seq)', 'max')
          .getRawOne();
        let next = Number(last?.max ?? 0);
        for (const e of unnumbered) {
          next += 1;
          e.seq = next;
        }
        await this.jobs.save(unnumbered);
        this.logger.log(
          `Backfilled seq for ${unnumbered.length} import row(s)`,
        );
      }
    } catch (err) {
      this.logger.warn(`seq backfill skipped: ${(err as Error).message}`);
    }
    // Always runs (even when the backfills above early-return): drop
    // stale run-server rows from a previous boot and kill orphans.
    try {
      await this.reconcileRunServers();
    } catch (err) {
      this.logger.warn(
        `run-server reconcile skipped: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Create one import. The result reports whether the game already
   * existed (`reused`) and — when it did — the name of the folder the
   * existing import lives in, so the UI can say where to find it.
   * `force` starts a fresh run even when the game already exists.
   */
  async create(
    sourceUrl: string,
    folderId?: string | null,
    force = false,
  ): Promise<
    ImportJob & { reused?: boolean; existingFolderName?: string | null }
  > {
    const r = await this.createOne(sourceUrl, folderId, force);
    return {
      ...r.job,
      reused: r.reused,
      ...(r.reused ? { existingFolderName: r.existingFolderName ?? null } : {}),
    };
  }

  /**
   * Create (or reuse) one import. Deduplication is GLOBAL per game:
   *  - any prior row for the same game (ANY status, including failed or
   *    cancelled) means the import already exists — the existing job is
   *    returned as `reused` with its folder name, never a duplicate row;
   *  - `force: true` skips the dedup check and always starts a fresh run
   *    (explicit Re-import intent from the console).
   *
   * `folderId` scopes the job into a console folder (validated first);
   * the pseudo-id `'none'` (and empty values) mean ungrouped.
   */
  private async createOne(
    sourceUrl: string,
    folderId?: string | null,
    force = false,
  ): Promise<{
    job: ImportJob;
    reused: boolean;
    existingFolderName?: string | null;
  }> {
    // Validate SourcePolicy BEFORE creating/enqueueing anything to download.
    try {
      this.policy.assertAllowed(sourceUrl);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const scope = folderId && folderId !== 'none' ? folderId : null;
    if (scope) await this.folders.assertExists(scope);
    const key = normalizeSourceKey(sourceUrl);
    if (!force) {
      const prior = await this.jobs.find({
        where: { sourceKey: key },
        order: { updatedAt: 'DESC' },
        take: 1,
      });
      if (prior.length) {
        const existing = prior[0];
        const folderName = await this.folderNameOf(existing.folderId);
        existing.logs = [
          ...(existing.logs ?? []),
          {
            at: new Date().toISOString(),
            level: 'info',
            message: 'Duplicate submit — import already exists; reused',
            step: existing.currentStep ?? existing.status,
          },
        ];
        await this.jobs.save(existing);
        return {
          job: toJob(existing),
          reused: true,
          existingFolderName: folderName,
        };
      }
    }
    const entity = this.jobs.create({
      id: randomUUID(),
      seq: await this.nextSeq(),
      sourceKey: key,
      sourceUrl,
      status: 'queued',
      progress: 0,
      detectedEngine: null,
      downloadedFiles: 0,
      totalFiles: 0,
      currentStep: 'queued',
      error: null,
      packageUrl: null,
      folderId: scope,
      logs: [
        {
          at: new Date().toISOString(),
          level: 'info',
          message: 'Import job created',
          step: 'queued',
        },
      ],
    });
    await this.jobs.save(entity);
    await this.queue.enqueue(entity.id);
    const saved = await this.jobs.findOneOrFail({ where: { id: entity.id } });
    return { job: toJob(saved), reused: false };
  }

  /** Resolve a folder's display name (null for ungrouped/unknown). */
  private async folderNameOf(
    folderId: string | null | undefined,
  ): Promise<string | null> {
    if (!folderId) return null;
    const view = await this.folders.get(folderId).catch(() => null);
    return view?.name ?? null;
  }

  /**
   * Batch-create imports from several game URLs (one line each). Duplicate
   * URLs inside the batch are coalesced; each URL follows the same global
   * reuse policy as `create`. `duplicates` reports every already-existing
   * game with the folder it lives in, so the UI can tell the operator.
   */
  async createBatch(
    sourceUrls: string[],
    folderId?: string | null,
    force = false,
  ): Promise<{
    created: number;
    reused: number;
    jobs: ImportJob[];
    duplicates: {
      sourceUrl: string;
      jobId: string;
      folderName: string | null;
    }[];
  }> {
    const seen = new Map<string, string>();
    for (const raw of sourceUrls ?? []) {
      const url = raw.trim();
      if (!url) continue;
      const key = normalizeSourceKey(url);
      if (!seen.has(key)) seen.set(key, url);
    }
    const urls = [...seen.values()];
    if (!urls.length) {
      throw new BadRequestException('Provide at least one game URL.');
    }
    const scope = folderId && folderId !== 'none' ? folderId : null;
    if (scope) await this.folders.assertExists(scope);
    // Fail fast if any URL is not allowlisted.
    const blocked: string[] = [];
    for (const url of urls) {
      try {
        this.policy.assertAllowed(url);
      } catch {
        blocked.push(url);
      }
    }
    if (blocked.length) {
      throw new BadRequestException(
        `Not allowed by SourcePolicy: ${blocked
          .slice(0, 3)
          .join(', ')}${blocked.length > 3 ? ', …' : ''}.`,
      );
    }
    let created = 0;
    let reused = 0;
    const jobs: ImportJob[] = [];
    const duplicates: {
      sourceUrl: string;
      jobId: string;
      folderName: string | null;
    }[] = [];
    for (const url of urls) {
      const r = await this.createOne(url, scope, force);
      if (r.reused) {
        reused += 1;
        duplicates.push({
          sourceUrl: r.job.sourceUrl,
          jobId: r.job.id,
          folderName: r.existingFolderName ?? null,
        });
      } else {
        created += 1;
      }
      jobs.push(r.job);
    }
    return { created, reused, jobs, duplicates };
  }

  /**
   * Discover the games listed on a source page (category/tag/home). The
   * adapter performs the policy-guarded, SSRF-safe fetch + static parse;
   * this method only annotates each with its dedup identity and whether an
   * import already exists. The returned `url`s feed straight into a batch.
   */
  async discoverGames(
    pageUrl: string,
  ): Promise<{ pageUrl: string; games: DiscoveredGameView[]; note?: string }> {
    try {
      this.policy.assertAllowed(pageUrl);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const adapter = this.sources.findAdapter(pageUrl);
    if (!adapter?.listGames) {
      throw new BadRequestException(
        'Game listing discovery is only supported for CrazyGames pages (www.crazygames.com).',
      );
    }
    let listed: ListedGamesResult;
    try {
      listed = await adapter.listGames(pageUrl, { timeoutMs: 30_000 });
    } catch (err) {
      if (
        err instanceof SourceAccessRestrictedError ||
        err instanceof SourceRedirectedError
      ) {
        throw new BadRequestException((err as Error).message);
      }
      throw err;
    }
    if (!listed.games.length) {
      return {
        pageUrl,
        games: [],
        ...(listed.note ? { note: listed.note } : {}),
      };
    }
    const keys = [
      ...new Set(listed.games.map((g) => normalizeSourceKey(g.url))),
    ];
    const rows = await this.jobs.find({ where: { sourceKey: In(keys) } });
    const statusByKey = new Map<string, string>();
    for (const row of rows) {
      if (row.sourceKey && !statusByKey.has(row.sourceKey)) {
        statusByKey.set(row.sourceKey, row.status);
      }
    }
    const games: DiscoveredGameView[] = listed.games.map((g) => {
      const key = normalizeSourceKey(g.url);
      const status = statusByKey.get(key);
      return {
        url: g.url,
        key,
        title: g.title,
        ...(g.thumbnail ? { thumbnail: g.thumbnail } : {}),
        already: status !== undefined,
        ...(status ? { status } : {}),
      };
    });
    return { pageUrl, games, ...(listed.note ? { note: listed.note } : {}) };
  }

  async get(id: string): Promise<ImportJob> {
    const e = await this.jobs.findOne({ where: { id } });
    if (!e) throw new NotFoundException(`Import job not found: ${id}`);
    const job = toJob(e);
    // On-demand size of this game's stored package (single dir walk;
    // the listing stays light and never pays for it).
    if (e.packageUrl) {
      const usage = await dirUsage(e.packageUrl);
      job.packageBytes = usage.bytes;
      job.packageFiles = usage.files;
    }
    return job;
  }

  /**
   * Most-recent jobs first (for the management console). Read-only; changes
   * nothing about queueing or processing. Paginated so large queues stay
   * browsable without pulling everything at once.
   */
  /**
   * Most-recent jobs first (for the management console). Read-only; changes
   * nothing about queueing or processing. Paginated so large queues stay
   * browsable without pulling everything at once. When `folderId` is given
   * only that folder's jobs are listed; `folderId='none'` lists only
   * ungrouped jobs; omitted lists everything. `status` filters to one
   * ImportState; `sort`/`dir` order the page (default: newest first).
   */
  async list(
    page = 1,
    limit = 50,
    folderId?: string | null,
    status?: string | null,
    sort: 'seq' | 'updatedAt' | 'status' | 'progress' = 'updatedAt',
    dir: 'ASC' | 'DESC' = 'DESC',
    q?: string | null,
  ): Promise<ImportJobPage> {
    const pageSize = Math.min(Math.max(limit, 1), 200);
    const cur = Math.max(page, 1);
    const where: FindOptionsWhere<ImportJobEntity> = {};
    if (folderId !== undefined && folderId !== null && folderId !== 'none') {
      where.folderId = folderId;
    } else if (folderId === 'none') {
      where.folderId = IsNull() as unknown as string;
    }
    if (status && VALID_STATUSES.has(status)) {
      where.status = status as ImportState;
    }
    const needle = (q ?? '').trim().slice(0, 200);
    if (needle) {
      where.sourceUrl = Like(`%${needle}%`);
    }
    const hasWhere = Object.keys(where).length > 0;
    const orderKey =
      sort === 'seq' || sort === 'status' || sort === 'progress'
        ? sort
        : 'updatedAt';
    const [entities, total] = await this.jobs.findAndCount({
      ...(hasWhere ? { where } : {}),
      order: { [orderKey]: dir === 'ASC' ? 'ASC' : 'DESC' },
      skip: (cur - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: entities.map(toJobSummary),
      total,
      page: cur,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    };
  }

  /**
   * Reset one failed/cancelled row back to queued and re-enqueue it IN
   * PLACE (same id, same seq, same folder). Unlike force-create, this
   * never adds rows — folder totals stay stable across retries.
   */
  private async resetForRetry(e: ImportJobEntity): Promise<ImportJob> {
    e.status = 'queued';
    e.progress = 0;
    e.downloadedFiles = 0;
    e.totalFiles = 0;
    e.currentStep = 'queued';
    e.error = null;
    e.errorCode = null;
    e.packageUrl = null;
    e.logs = [
      ...(e.logs ?? []),
      {
        at: new Date().toISOString(),
        level: 'info',
        message: 'Retried by user — queued again',
        step: 'queued',
      },
    ];
    await this.jobs.save(e);
    await this.queue.enqueue(e.id);
    return toJob(e);
  }

  /**
   * Retry explicit job ids in place. Only failed/cancelled rows are
   * retried; anything else (missing, in-flight, completed) is reported
   * in `skipped` and left untouched — resetting a running or finished
   * job would corrupt it.
   */
  async retryJobs(ids: string[]): Promise<{
    retried: number;
    jobs: ImportJob[];
    skipped: { id: string; reason: string }[];
  }> {
    const jobs: ImportJob[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const seen = new Set<string>();
    for (const id of ids ?? []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const e = await this.jobs.findOne({ where: { id } });
      if (!e) {
        skipped.push({ id, reason: 'not-found' });
        continue;
      }
      if (e.status !== 'failed' && e.status !== 'cancelled') {
        skipped.push({ id, reason: `status-${e.status}` });
        continue;
      }
      jobs.push(await this.resetForRetry(e));
    }
    return { retried: jobs.length, jobs, skipped };
  }

  /**
   * Re-run every FAILED job in one scope IN PLACE (same rows, back to
   * queued). Totals never inflate: retrying 40 failed games keeps 40
   * rows, they just move back to in-flight. `folderId`: a real folder
   * id, `'none'` for ungrouped only, omitted for everything.
   */
  async retryFailed(folderId?: string | null): Promise<{
    retried: number;
    jobs: ImportJob[];
  }> {
    const where: FindOptionsWhere<ImportJobEntity> = { status: 'failed' };
    if (folderId !== undefined && folderId !== null && folderId !== 'none') {
      await this.folders.assertExists(folderId);
      where.folderId = folderId;
    } else if (folderId === 'none') {
      where.folderId = IsNull() as unknown as string;
    }
    const failed = await this.jobs.find({
      where,
      select: ['id'],
      order: { updatedAt: 'DESC' },
    });
    if (!failed.length) {
      return { retried: 0, jobs: [] };
    }
    const r = await this.retryJobs(failed.map((j) => j.id));
    return { retried: r.retried, jobs: r.jobs };
  }

  /**
   * Restore a library from a backup file (produced by GET
   * /folders/export). Folders are matched by NAME (ids never survive a
   * restore): missing folders are created, existing ones reused, and the
   * 'Ungrouped' group files jobs outside any folder. Games that already
   * exist anywhere are skipped via the global dedup — the import never
   * duplicates, only fills in what is missing.
   */
  async importBackup(backup: {
    folders?: { name?: unknown; games?: { sourceUrl?: unknown }[] }[];
  }): Promise<{
    foldersCreated: number;
    foldersReused: number;
    gamesCreated: number;
    gamesSkipped: number;
  }> {
    const groups = Array.isArray(backup?.folders) ? backup.folders : [];
    let foldersCreated = 0;
    let foldersReused = 0;
    let gamesCreated = 0;
    let gamesSkipped = 0;
    const knownNames = new Set((await this.folders.list()).map((f) => f.name));
    const seenFolders = new Map<string, string | null>();
    for (const group of groups) {
      const rawName = typeof group?.name === 'string' ? group.name.trim() : '';
      const games = Array.isArray(group?.games) ? group.games : [];
      // Nameless groups are skipped; the exporter's ungrouped bucket
      // (id null, name 'Ungrouped') files jobs outside any folder.
      if (!rawName) continue;
      const ungrouped = rawName.toLowerCase() === 'ungrouped';
      let folderId: string | null = null;
      if (!ungrouped) {
        const hit = seenFolders.get(rawName);
        if (hit !== undefined) {
          folderId = hit;
        } else {
          const existed = knownNames.has(rawName);
          const view = await this.folders.resolveByName(rawName);
          folderId = view.id;
          knownNames.add(rawName);
          if (existed) foldersReused += 1;
          else foldersCreated += 1;
          seenFolders.set(rawName, folderId);
        }
      }
      for (const g of games) {
        if (typeof g?.sourceUrl !== 'string' || !g.sourceUrl.trim()) continue;
        const r = await this.createOne(g.sourceUrl.trim(), folderId);
        if (r.reused) gamesSkipped += 1;
        else gamesCreated += 1;
      }
    }
    this.logger.log(
      `Backup import: ${foldersCreated} folder(s) created, ` +
        `${foldersReused} reused, ${gamesCreated} game(s) created, ` +
        `${gamesSkipped} skipped (already exist).`,
    );
    return { foldersCreated, foldersReused, gamesCreated, gamesSkipped };
  }

  async cancel(id: string): Promise<ImportJob> {
    const e = await this.jobs.findOne({ where: { id } });
    if (!e) throw new NotFoundException(`Import job not found: ${id}`);
    if (e.status === 'completed' || e.status === 'failed') {
      throw new BadRequestException(`Cannot cancel job in status ${e.status}`);
    }
    e.status = 'cancelled';
    e.currentStep = 'cancelled';
    e.logs = [
      ...(e.logs ?? []),
      {
        at: new Date().toISOString(),
        level: 'info',
        message: 'Import cancelled by user',
        step: 'cancelled',
      },
    ];
    await this.jobs.save(e);
    return toJob(e);
  }

  async logs(id: string): Promise<ImportJobLogEntry[]> {
    const e = await this.jobs.findOne({ where: { id } });
    if (!e) throw new NotFoundException(`Import job not found: ${id}`);
    return (e.logs ?? []) as ImportJobLogEntry[];
  }

  /**
   * Delete one job completely: stop its local server (if running), drop
   * the DB row, and remove its package + work directories from disk.
   * In-flight jobs are cancelled first (best-effort) so the worker bails
   * out instead of recreating files. Disk removal is root-guarded: only
   * paths strictly inside the storage/work roots are ever touched.
   */
  async remove(id: string): Promise<{
    deleted: true;
    clearedPackage: boolean;
    clearedWork: boolean;
    wasRunning: boolean;
  }> {
    const e = await this.jobs.findOne({ where: { id } });
    if (!e) throw new NotFoundException(`Import job not found: ${id}`);

    // Best-effort: mark in-flight rows cancelled so the worker bails out
    // at its next checkpoint instead of re-uploading after we wipe files.
    if (e.status !== 'completed' && e.status !== 'failed') {
      e.status = 'cancelled';
      e.currentStep = 'cancelled';
      await this.jobs.save(e).catch(() => undefined);
    }

    // Stop a local server started from this job, if any.
    let wasRunning = false;
    const entry = this.running.get(id);
    if (entry) {
      wasRunning = true;
      this.running.delete(id);
      try {
        entry.browser?.kill();
      } catch {
        /* best-effort */
      }
      try {
        entry.child.kill();
      } catch {
        /* best-effort */
      }
    }
    // …or a persisted row without a live handle: kill by pid, drop row.
    const row = await this.servers
      .findOne({ where: { jobId: id } })
      .catch(() => null);
    if (row) {
      wasRunning = true;
      if (row.pid != null) killPid(row.pid);
      await this.servers.delete({ jobId: id }).catch(() => undefined);
    } else if (entry) {
      await this.servers.delete({ jobId: id }).catch(() => undefined);
    }

    const pkgRoot = e.packageUrl ? path.resolve(e.packageUrl) : null;
    await this.jobs.remove(e);
    const clearedPackage = pkgRoot
      ? await this.rmWithin(this.storageRoot(), pkgRoot)
      : false;
    const clearedWork = await this.rmWithin(
      this.workRoot(),
      path.join(this.workRoot(), id),
    );
    this.logger.log(
      `Deleted job ${id}: package=${clearedPackage}, work=${clearedWork}`,
    );
    return { deleted: true, clearedPackage, clearedWork, wasRunning };
  }

  /**
   * Remove `target` only when it sits strictly inside `root` (never the
   * root itself, never anything outside it). Returns whether it removed.
   */
  private async rmWithin(root: string, target: string): Promise<boolean> {
    try {
      const r = path.resolve(root);
      const t = path.resolve(target);
      if (t === r || !t.startsWith(r + path.sep)) return false;
      await fs.promises.rm(t, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private workRoot(): string {
    return path.resolve(process.env.IMPORT_WORK_DIR ?? './data/work');
  }

  private storageRoot(): string {
    return path.resolve(process.env.STORAGE_LOCAL_ROOT ?? './data/packages');
  }

  /**
   * Serve a completed game's package directory through the SAME path the
   * operator uses manually — `python -m http.server` rooted at the package
   * dir (`cd` + python) — and open it in the default browser. Reusing the
   * exact manual flow guarantees the served page behaves identically to the
   * hand-run command the user already trusts. Only runs for real completed
   * packages; never executes imported game code server-side.
   */
  async run(id: string): Promise<RunningGameView> {
    const existing = this.running.get(id);
    if (existing) {
      return { url: existing.url, port: existing.port };
    }
    const e = await this.jobs.findOne({ where: { id } });
    if (!e) throw new NotFoundException(`Import job not found: ${id}`);
    if (e.status !== 'completed' || !e.packageUrl) {
      throw new BadRequestException(
        'Only completed imports with a local package can be served.',
      );
    }
    const root = path.resolve(e.packageUrl);
    let isDir = false;
    try {
      isDir = (await fs.promises.stat(root)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new BadRequestException(
        `Package directory not found on this host: ${root}`,
      );
    }

    const port = await findFreePort();
    const {
      url,
      port: actualPort,
      child,
    } = await this.launchServer(root, port);

    const entry: RunServerEntry = { child, root, url, port: actualPort };
    entry.browser = this.openInBrowser(url) ?? undefined;
    this.running.set(id, entry);
    // Persist so a restart can find (and kill) this server instead of
    // orphaning it. `save` upserts on the jobId primary key.
    await this.servers
      .save({
        jobId: id,
        port: actualPort,
        pid: child.pid ?? null,
        url,
        root,
      })
      .catch((err) =>
        this.logger.warn(`Could not persist run server row: ${err?.message}`),
      );
    return { url, port: actualPort };
  }

  /**
   * Stop the `python -m http.server` process started by {@link run} for a
   * job (if any). The browser tab itself is user-managed; closing a browser
   * window is not reliable cross-platform, so this only kills the server.
   * Falls back to the persisted row (kill by pid) when the live handle is
   * gone — e.g. the row outlived the process map.
   */
  async stop(id: string): Promise<{ url: string | null; stopped: boolean }> {
    const entry = this.running.get(id);
    if (entry) {
      this.running.delete(id);
      if (entry.browser) {
        try {
          entry.browser.kill();
        } catch {
          /* best-effort */
        }
      }
      try {
        entry.child.kill();
      } catch {
        /* best-effort */
      }
      await this.servers.delete({ jobId: id }).catch(() => undefined);
      return { url: entry.url, stopped: true };
    }
    const row = await this.servers
      .findOne({ where: { jobId: id } })
      .catch(() => null);
    if (!row) return { url: null, stopped: false };
    if (row.pid != null) killPid(row.pid);
    await this.servers.delete({ jobId: id }).catch(() => undefined);
    return { url: row.url, stopped: true };
  }

  /**
   * Stop every running local server (live handles first, then any
   * persisted rows left without one — killed by pid). Used before
   * destructive maintenance (e.g. clearing packages) because on Windows
   * a running `python -m http.server` locks its package directory and
   * makes deletion fail with EBUSY.
   */
  async stopAllRuns(): Promise<{ stopped: number }> {
    let stopped = 0;
    for (const id of [...this.running.keys()]) {
      try {
        const r = await this.stop(id);
        if (r.stopped) stopped += 1;
      } catch {
        /* best-effort per server */
      }
    }
    // Sweep persisted rows that have no live handle (defensive).
    try {
      const rows = await this.servers.find();
      for (const r of rows) {
        if (r.pid != null) killPid(r.pid);
      }
      if (rows.length) await this.servers.clear();
    } catch {
      /* best-effort */
    }
    return { stopped };
  }

  /**
   * Reconcile run-server rows left behind by a previous boot: any python
   * process that is still alive AND still answering its recorded port is
   * an orphan of the restart, so it is killed; every row is dropped so
   * the fresh boot starts with no ghosts and free ports. The double
   * check (pid alive + port answers) guards against PID recycling
   * pointing at an unrelated process — a recycled pid almost never still
   * serves our exact loopback port.
   */
  async reconcileRunServers(): Promise<{ killed: number; cleared: number }> {
    let rows: RunServerEntity[] = [];
    try {
      rows = await this.servers.find();
    } catch {
      return { killed: 0, cleared: 0 };
    }
    let killed = 0;
    for (const r of rows) {
      if (r.pid != null && isAlive(r.pid) && (await isPortOpen(r.port))) {
        if (killPid(r.pid)) killed += 1;
      }
      try {
        await this.servers.remove(r);
      } catch {
        /* best-effort */
      }
    }
    if (rows.length) {
      this.logger.log(
        `Reconciled ${rows.length} stale run server(s) from a previous boot; killed ${killed} orphan process(es).`,
      );
    }
    return { killed, cleared: rows.length };
  }
}
