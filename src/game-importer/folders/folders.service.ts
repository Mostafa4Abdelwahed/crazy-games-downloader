import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Repository } from 'typeorm';
import { GameFolderEntity } from '../entities/game-folder.entity';
import { ImportJobEntity } from '../entities/import-job.entity';
import { dirUsage } from '../storage/disk-usage';

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

  /** Real packages root (same root for every folder; shown for copy). */
  packagesRoot(): string {
    return path.resolve(process.env.STORAGE_LOCAL_ROOT ?? './data/packages');
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
