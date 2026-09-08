import {
  Injectable,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ImportJobEntity } from './entities/import-job.entity';
import { SourcePolicyService } from './core/source-policy';
import { ImportQueueService } from './queue/import.queue';
import { ImportJob, ImportJobLogEntry, ImportState } from './core/types';
import { DiagnosticLevel, ImportDiagnostic } from './core/diagnostics';
import { SourceRegistry } from './sources/source-registry';
import {
  ListedGamesResult,
  SourceAccessRestrictedError,
  SourceRedirectedError,
} from './sources/source.interface';

const LEVELS: DiagnosticLevel[] = ['info', 'warning', 'error'];

const TERMINAL_STATES = new Set<ImportState>([
  'completed',
  'failed',
  'cancelled',
]);

function isTerminal(s: ImportState): boolean {
  return TERMINAL_STATES.has(s);
}

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
 * Paginated job listing for the management console: one page of jobs plus
 * enough metadata to render Prev/Next and "Page X of Y" controls.
 */
export interface ImportJobPage {
  items: ImportJob[];
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

function toJob(e: ImportJobEntity): ImportJob {
  return {
    id: e.id,
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
    createdAt: e.createdAt?.toISOString?.() ?? new Date().toISOString(),
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
  ) {}

  /**
   * Backfill `sourceKey` for rows created before dedup existed (their
   * column defaulted to `''`), so previously-added games dedup against
   * re-submissions the same way new ones do.
   */
  async onModuleInit(): Promise<void> {
    try {
      const missing = await this.jobs.find({
        where: { sourceKey: '' },
        order: { updatedAt: 'DESC' },
      });
      if (!missing.length) return;
      for (const e of missing) e.sourceKey = normalizeSourceKey(e.sourceUrl);
      await this.jobs.save(missing);
      this.logger.log(
        `Backfilled sourceKey for ${missing.length} import row(s)`,
      );
    } catch (err) {
      this.logger.warn(`sourceKey backfill skipped: ${(err as Error).message}`);
    }
  }

  async create(sourceUrl: string): Promise<ImportJob> {
    return (await this.createOne(sourceUrl)).job;
  }

  /**
   * Create (or reuse) one import. Deduplication policy:
   *  - when the same game is already in flight (queued/detecting/...),
   *    the existing job is returned untouched-ish (logged as reused) —
   *    never a duplicate row;
   *  - when the previous run for the game reached a terminal state
   *    (completed/failed/cancelled), a fresh run is started ("update").
   */
  private async createOne(
    sourceUrl: string,
  ): Promise<{ job: ImportJob; reused: boolean }> {
    // Validate SourcePolicy BEFORE creating/enqueueing anything to download.
    try {
      this.policy.assertAllowed(sourceUrl);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
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
      const r = await this.createOne(url);
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
  async list(page = 1, limit = 50): Promise<ImportJobPage> {
    const pageSize = Math.min(Math.max(limit, 1), 200);
    const cur = Math.max(page, 1);
    const [entities, total] = await this.jobs.findAndCount({
      order: { updatedAt: 'DESC' },
      skip: (cur - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: entities.map(toJob),
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
}
