import {
  Injectable,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
  Logger,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { ImportJobEntity } from './entities/import-job.entity';
import { SourcePolicyService } from './core/source-policy';
import { ImportQueueService } from './queue/import.queue';
import { ImportJob, ImportJobLogEntry, ImportState } from './core/types';
import { DiagnosticLevel, ImportDiagnostic } from './core/diagnostics';
import { SourceRegistry } from './sources/source-registry';
import { FoldersService } from './folders/folders.service';
import {
  ListedGamesResult,
  SourceAccessRestrictedError,
  SourceRedirectedError,
} from './sources/source.interface';

const LEVELS: DiagnosticLevel[] = ['info', 'warning', 'error'];

/** DI token for the function that opens a URL in the default browser. */
export const GAME_BROWSER_OPENER = Symbol('GAME_BROWSER_OPENER');

const TERMINAL_STATES = new Set<ImportState>([
  'completed',
  'failed',
  'cancelled',
]);

function isTerminal(s: ImportState): boolean {
  return TERMINAL_STATES.has(s);
}

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
      if (!unnumbered.length) return;
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
      this.logger.log(`Backfilled seq for ${unnumbered.length} import row(s)`);
    } catch (err) {
      this.logger.warn(`seq backfill skipped: ${(err as Error).message}`);
    }
  }

  async create(
    sourceUrl: string,
    folderId?: string | null,
  ): Promise<ImportJob> {
    return (await this.createOne(sourceUrl, folderId)).job;
  }

  /**
   * Create (or reuse) one import. Deduplication policy:
   *  - when the same game is already in flight (queued/detecting/...),
   *    the existing job is returned untouched-ish (logged as reused) —
   *    never a duplicate row;
   *  - when the previous run for the game reached a terminal state
   *    (completed/failed/cancelled), a fresh run is started ("update").
   *
   * `folderId` scopes the job into a console folder (validated first).
   */
  private async createOne(
    sourceUrl: string,
    folderId?: string | null,
  ): Promise<{ job: ImportJob; reused: boolean }> {
    // Validate SourcePolicy BEFORE creating/enqueueing anything to download.
    try {
      this.policy.assertAllowed(sourceUrl);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    if (folderId) await this.folders.assertExists(folderId);
    const key = normalizeSourceKey(sourceUrl);
    const prior = await this.jobs.find({
      where: { sourceKey: key },
      order: { updatedAt: 'DESC' },
      take: 1,
    });
    if (prior.length && !isTerminal(prior[0].status)) {
      const existing = prior[0];
      existing.logs = [
        ...(existing.logs ?? []),
        {
          at: new Date().toISOString(),
          level: 'info',
          message: 'Duplicate submit — import already in progress; reused',
          step: existing.currentStep ?? existing.status,
        },
      ];
      await this.jobs.save(existing);
      return { job: toJob(existing), reused: true };
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
      folderId: folderId ?? null,
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

  /**
   * Batch-create imports from several game URLs (one line each). Duplicate
   * URLs inside the batch are coalesced; each URL follows the same
   * reuse-or-update policy as `create`.
   */
  async createBatch(
    sourceUrls: string[],
    folderId?: string | null,
  ): Promise<{ created: number; reused: number; jobs: ImportJob[] }> {
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
    if (folderId) await this.folders.assertExists(folderId);
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
    for (const url of urls) {
      const r = await this.createOne(url, folderId);
      if (r.reused) reused += 1;
      else created += 1;
      jobs.push(r.job);
    }
    return { created, reused, jobs };
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
    return toJob(e);
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
    return { url, port: actualPort };
  }

  /**
   * Stop the `python -m http.server` process started by {@link run} for a
   * job (if any). The browser tab itself is user-managed; closing a browser
   * window is not reliable cross-platform, so this only kills the server.
   */
  async stop(id: string): Promise<{ url: string | null; stopped: boolean }> {
    const entry = this.running.get(id);
    if (!entry) return { url: null, stopped: false };
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
    return { url: entry.url, stopped: true };
  }
}
