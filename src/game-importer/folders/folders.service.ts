import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Repository } from 'typeorm';
import { GameFolderEntity } from '../entities/game-folder.entity';
import { ImportJobEntity } from '../entities/import-job.entity';
import { dirUsage } from '../storage/disk-usage';

/**
 * URL-safe slug used for export directory names. Mirrors the engine
 * `deriveSlug` rules (lowercase, non-alphanumerics to dashes, trimmed,
 * max 80 chars). Returns '' when nothing slug-safe remains (e.g. a
 * non-latin folder name) so callers can fall back to an id-based name.
 */
export function slugifyName(input: string): string {
  return (input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Folder view rendered on the home page: name, job stats and the real
 * on-disk packages root the operator can copy for external use.
 */
export interface FolderView {
  id: string;
  name: string;
  createdAt: string;
  jobCounts: {
    total: number;
    inFlight: number;
    completed: number;
    failed: number;
  };
  /** Real filesystem root that holds every stored package. */
  packagesRoot: string;
  /** On-disk usage of this folder's stored packages (opt-in via ?storage). */
  storage?: { bytes: number; packages: number };
}

const IN_FLIGHT = [
  'queued',
  'detecting',
  'resolving',
  'downloading',
  'extracting',
  'validating',
  'uploading',
] as const;

/**
 * Folder management for the home page: create/rename/delete named game
 * groups, list them with live stats, and expose the real packages path
 * for copy-to-clipboard. Deleting a folder keeps its jobs (they move to
 * the ungrouped collection) so nothing is ever lost by a folder action.
 */
@Injectable()
export class FoldersService {
  private readonly logger = new Logger(FoldersService.name);

  constructor(
    @InjectRepository(GameFolderEntity)
    private readonly folders: Repository<GameFolderEntity>,
    @InjectRepository(ImportJobEntity)
    private readonly jobs: Repository<ImportJobEntity>,
  ) {}

  async list(withStorage = false): Promise<FolderView[]> {
    const rows = await this.folders.find({
      order: { createdAt: 'ASC' },
    });
    // One disk pass for every stored package (shared by all folders),
    // keyed by job id so each folder just sums its own slice.
    const usageByJob = withStorage ? await this.packageUsageByJob() : new Map();
    const views: FolderView[] = [];
    for (const f of rows) {
      const all = await this.jobs.find({
        where: { folderId: f.id },
        select: ['id', 'status'],
      });
      const view = this.toView(
        f,
        all.map((j) => j.status),
      );
      if (withStorage) {
        let bytes = 0;
        let packages = 0;
        for (const j of all) {
          const u = usageByJob.get(j.id);
          if (u && (u.bytes > 0 || u.files > 0)) {
            bytes += u.bytes;
            packages += 1;
          }
        }
        view.storage = { bytes, packages };
      }
      views.push(view);
    }
    return views;
  }

  async get(id: string): Promise<FolderView> {
    const f = await this.folders.findOne({ where: { id } });
    if (!f) throw new BadRequestException(`Folder not found: ${id}`);
    const all = await this.jobs.find({
      where: { folderId: id },
      select: ['status'],
    });
    return this.toView(
      f,
      all.map((j) => j.status),
    );
  }

  async create(name: string): Promise<FolderView> {
    const clean = (name ?? '').trim();
    if (!clean) throw new BadRequestException('Folder name is required.');
    const exists = await this.folders.findOne({ where: { name: clean } });
    if (exists) {
      throw new BadRequestException(`Folder name already used: ${clean}`);
    }
    const f = await this.folders.save(
      this.folders.create({ id: randomUUID(), name: clean }),
    );
    this.logger.log(`Created folder "${clean}" (${f.id})`);
    return this.toView(f, []);
  }

  async rename(id: string, name: string): Promise<FolderView> {
    const clean = (name ?? '').trim();
    if (!clean) throw new BadRequestException('Folder name is required.');
    const f = await this.folders.findOne({ where: { id } });
    if (!f) throw new BadRequestException(`Folder not found: ${id}`);
    const exists = await this.folders.findOne({ where: { name: clean } });
    if (exists && exists.id !== id) {
      throw new BadRequestException(`Folder name already used: ${clean}`);
    }
    f.name = clean;
    await this.folders.save(f);
    return this.get(id);
  }

  /**
   * Delete a folder row. Its jobs are unassigned first (folderId=null) so
   * history and packages are preserved in the ungrouped collection.
   */
  async delete(id: string): Promise<{ deleted: true; unassigned: number }> {
    const f = await this.folders.findOne({ where: { id } });
    if (!f) throw new BadRequestException(`Folder not found: ${id}`);
    const owned = await this.jobs.find({
      where: { folderId: id },
      select: ['id'],
    });
    if (owned.length) {
      for (const j of owned) j.folderId = null;
      await this.jobs.save(owned);
    }
    await this.folders.remove(f);
    this.logger.log(
      `Deleted folder "${f.name}" (${id}); ${owned.length} job(s) unassigned`,
    );
    return { deleted: true, unassigned: owned.length };
  }

  /** Move a job into a folder (or out of every folder with null). */
  async assignJob(
    jobId: string,
    folderId: string | null,
  ): Promise<{ jobId: string; folderId: string | null }> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) throw new BadRequestException(`Job not found: ${jobId}`);
    if (folderId) {
      const f = await this.folders.findOne({ where: { id: folderId } });
      if (!f) throw new BadRequestException(`Folder not found: ${folderId}`);
    }
    job.folderId = folderId;
    await this.jobs.save(job);
    return { jobId, folderId };
  }

  /** Validate a folder exists (used by job creation scoping). */
  async assertExists(folderId: string): Promise<void> {
    const f = await this.folders.findOne({ where: { id: folderId } });
    if (!f) throw new BadRequestException(`Folder not found: ${folderId}`);
  }

  /**
   * Find a folder by name, creating it when missing. Used by backup
   * import (ids never survive a restore, names do).
   */
  async resolveByName(name: string): Promise<FolderView> {
    const clean = (name ?? '').trim();
    if (!clean) throw new BadRequestException('Folder name is required.');
    const existing = await this.folders.findOne({ where: { name: clean } });
    if (existing) {
      const all = await this.jobs.find({
        where: { folderId: existing.id },
        select: ['id', 'status'],
      });
      return this.toView(
        existing,
        all.map((j) => j.status),
      );
    }
    return this.create(clean);
  }

  /** Real packages root (same root for every folder; shown for copy). */
  packagesRoot(): string {
    return path.resolve(process.env.STORAGE_LOCAL_ROOT ?? './data/packages');
  }

  /** Base dir for organized per-folder exports (Copy, never Move). */
  exportsRoot(): string {
    return path.resolve(process.env.EXPORT_ROOT ?? './data/exports');
  }

  /**
   * Copy-out (Export) of one folder's reviewed packages:
   * `<exportsRoot>/<folder-slug>/approved/<game-slug>/…` and
   * `…/rejected/<game-slug>/…`, plus an `index.json` manifest.
   *
   * - Copy only (the originals + DB rows are untouched, run buttons keep
   *   working). Re-running wipes this folder's previous export first so a
   *   changed verdict never leaves a stale copy behind.
   * - Only `approved`/`rejected` jobs WITH an existing package dir are
   *   copied; pending/in-flight/missing-package jobs are counted as
   *   skipped (the operator asked for two buckets only).
   * - Directory names are slugs: the folder dir is the slugified folder
   *   name, each game dir prefers the package `manifest.json` slug, then
   *   the source-URL slug, then `game-<seq|id>`. Collisions get `-2`, …
   */
  async exportOrganized(id: string): Promise<{
    folderId: string;
    folderName: string;
    folderSlug: string;
    exportRoot: string;
    approved: number;
    rejected: number;
    skipped: number;
    failed: { jobId: string; error: string }[];
    approvedSlugs: string[];
    rejectedSlugs: string[];
  }> {
    const f = await this.folders.findOne({ where: { id } });
    if (!f) throw new BadRequestException(`Folder not found: ${id}`);
    const folderSlug = slugifyName(f.name) || `folder-${f.id.slice(0, 8)}`;
    const base = this.exportsRoot();
    const exportRoot = path.resolve(base, folderSlug);
    if (exportRoot !== base && !exportRoot.startsWith(base + path.sep)) {
      throw new BadRequestException('Export path escapes exports root.');
    }
    const approvedRoot = path.join(exportRoot, 'approved');
    const rejectedRoot = path.join(exportRoot, 'rejected');

    const jobs = await this.jobs.find({
      where: { folderId: id },
      select: ['id', 'seq', 'sourceUrl', 'reviewStatus', 'packageUrl'],
    });

    let skipped = 0;
    const failed: { jobId: string; error: string }[] = [];
    const approvedSlugs: string[] = [];
    const rejectedSlugs: string[] = [];
    const usedApproved = new Set<string>();
    const usedRejected = new Set<string>();
    const index: {
      jobId: string;
      seq: number | null;
      sourceUrl: string;
      reviewStatus: string;
      slug: string;
    }[] = [];
    const pendingCopy: { src: string; dest: string }[] = [];

    for (const j of jobs) {
      const verdict = (j as { reviewStatus?: string }).reviewStatus;
      if (verdict !== 'approved' && verdict !== 'rejected') {
        skipped += 1;
        continue;
      }
      const pkg = (j as { packageUrl?: string | null }).packageUrl;
      if (!pkg) {
        skipped += 1;
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(pkg);
      } catch {
        skipped += 1;
        continue;
      }
      if (!stat.isDirectory()) {
        skipped += 1;
        continue;
      }
      const used = verdict === 'approved' ? usedApproved : usedRejected;
      const slug = await this.uniqueGameSlug(j as never, used);
      used.add(slug);
      const dest = path.join(
        verdict === 'approved' ? approvedRoot : rejectedRoot,
        slug,
      );
      if (dest !== exportRoot && !dest.startsWith(exportRoot + path.sep)) {
        failed.push({ jobId: j.id, error: 'Destination escapes export root.' });
        continue;
      }
      pendingCopy.push({ src: pkg, dest });
      if (verdict === 'approved') approvedSlugs.push(slug);
      else rejectedSlugs.push(slug);
      index.push({
        jobId: j.id,
        seq: (j as { seq?: number | null }).seq ?? null,
        sourceUrl: (j as { sourceUrl?: string }).sourceUrl ?? '',
        reviewStatus: verdict,
        slug,
      });
    }

    // Fresh export per folder: drop the previous copy so re-reviews and
    // removed packages never leave stale dirs behind.
    await fs.promises.rm(exportRoot, { recursive: true, force: true });
    await fs.promises.mkdir(approvedRoot, { recursive: true });
    await fs.promises.mkdir(rejectedRoot, { recursive: true });

    for (const [i, item] of pendingCopy.entries()) {
      try {
        await fs.promises.cp(item.src, item.dest, { recursive: true });
      } catch (err) {
        failed.push({
          jobId: index[i]?.jobId ?? 'unknown',
          error: (err as Error).message,
        });
      }
    }
    const failedIds = new Set(failed.map((x) => x.jobId));
    const okApproved = approvedSlugs.filter((_, i) => {
      const item = index.filter((x) => x.reviewStatus === 'approved')[i];
      return item && !failedIds.has(item.jobId);
    });
    const okRejected = rejectedSlugs.filter((_, i) => {
      const item = index.filter((x) => x.reviewStatus === 'rejected')[i];
      return item && !failedIds.has(item.jobId);
    });

    await fs.promises.writeFile(
      path.join(exportRoot, 'index.json'),
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          folderId: f.id,
          folderName: f.name,
          folderSlug,
          items: index.filter((x) => !failedIds.has(x.jobId)),
        },
        null,
        2,
      ),
    );
    this.logger.log(
      `Exported folder "${f.name}" (${id}): ${okApproved.length} approved, ` +
        `${okRejected.length} rejected, ${skipped} skipped -> ${exportRoot}`,
    );
    return {
      folderId: f.id,
      folderName: f.name,
      folderSlug,
      exportRoot,
      approved: okApproved.length,
      rejected: okRejected.length,
      skipped,
      failed,
      approvedSlugs: okApproved,
      rejectedSlugs: okRejected,
    };
  }

  /** Unique game dir slug for one job (manifest slug -> URL slug -> fallback). */
  private async uniqueGameSlug(
    job: {
      id: string;
      seq?: number | null;
      sourceUrl?: string;
      packageUrl?: string | null;
    },
    used: Set<string>,
  ): Promise<string> {
    let base = '';
    if (job.packageUrl) {
      try {
        const raw = await fs.promises.readFile(
          path.join(job.packageUrl, 'manifest.json'),
          'utf8',
        );
        const slug = (JSON.parse(raw) as { slug?: unknown }).slug;
        if (typeof slug === 'string' && /^[a-z0-9-]{1,80}$/.test(slug)) {
          base = slug;
        }
      } catch {
        base = '';
      }
    }
    if (!base) base = slugifyName(this.slugFromUrl(job.sourceUrl ?? ''));
    if (!base) base = `game-${job.seq ?? job.id.slice(0, 8)}`;
    base = base.slice(0, 60) || `game-${job.id.slice(0, 8)}`;
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) {
      const suffix = `-${n}`;
      candidate = base.slice(0, 60 - suffix.length) + suffix;
      n += 1;
    }
    return candidate;
  }

  /** Last URL path segment (or hostname) used as the slug source. */
  private slugFromUrl(sourceUrl: string): string {
    try {
      const u = new URL(sourceUrl);
      const segs = u.pathname.split('/').filter(Boolean);
      return segs.pop() ?? u.hostname;
    } catch {
      return sourceUrl.split('/').filter(Boolean).pop() ?? '';
    }
  }

  /**
   * Portable backup of the whole library: every folder with its games
   * (source URL + status), plus ungrouped games. Package files are NOT
   * included — re-import rebuilds them; this file restores the structure.
   */
  async exportBackup(): Promise<{
    exportedAt: string;
    folders: {
      id: string | null;
      name: string;
      games: {
        seq: number | null;
        sourceUrl: string;
        status: string;
        createdAt: string;
      }[];
    }[];
  }> {
    const folders = await this.folders.find({ order: { createdAt: 'ASC' } });
    const jobs = await this.jobs.find({ order: { createdAt: 'ASC' } });
    const byFolder = new Map<string | null, typeof jobs>();
    for (const j of jobs) {
      const key = j.folderId ?? null;
      const arr = byFolder.get(key) ?? [];
      arr.push(j);
      byFolder.set(key, arr);
    }
    const out: Awaited<ReturnType<FoldersService['exportBackup']>>['folders'] =
      [];
    for (const f of folders) {
      out.push({
        id: f.id,
        name: f.name,
        games: (byFolder.get(f.id) ?? []).map((j) => ({
          seq: j.seq ?? null,
          sourceUrl: j.sourceUrl,
          status: j.status,
          createdAt: j.createdAt.toISOString(),
        })),
      });
    }
    const ungrouped = byFolder.get(null) ?? [];
    if (ungrouped.length) {
      out.push({
        id: null,
        name: 'Ungrouped',
        games: ungrouped.map((j) => ({
          seq: j.seq ?? null,
          sourceUrl: j.sourceUrl,
          status: j.status,
          createdAt: j.createdAt.toISOString(),
        })),
      });
    }
    return { exportedAt: new Date().toISOString(), folders: out };
  }

  /**
   * On-disk usage per stored package, keyed by job id. Packages whose
   * directory is missing (cleared) simply contribute nothing.
   */
  private async packageUsageByJob(): Promise<
    Map<string, { bytes: number; files: number }>
  > {
    const out = new Map<string, { bytes: number; files: number }>();
    const rows = await this.jobs.find({ select: ['id', 'packageUrl'] });
    for (const j of rows) {
      if (!j.packageUrl) continue;
      const usage = await dirUsage(j.packageUrl);
      if (usage.bytes > 0 || usage.files > 0) out.set(j.id, usage);
    }
    return out;
  }

  private toView(f: GameFolderEntity, statuses: string[]): FolderView {
    return {
      id: f.id,
      name: f.name,
      createdAt: f.createdAt.toISOString(),
      jobCounts: {
        total: statuses.length,
        inFlight: statuses.filter((s) =>
          (IN_FLIGHT as readonly string[]).includes(s),
        ).length,
        completed: statuses.filter((s) => s === 'completed').length,
        failed: statuses.filter((s) => s === 'failed').length,
      },
      packagesRoot: this.packagesRoot(),
    };
  }
}
