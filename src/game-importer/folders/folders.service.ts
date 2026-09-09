import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Repository } from 'typeorm';
import { GameFolderEntity } from '../entities/game-folder.entity';
import { ImportJobEntity } from '../entities/import-job.entity';

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

  async list(): Promise<FolderView[]> {
    const rows = await this.folders.find({
      order: { createdAt: 'ASC' },
    });
    const views: FolderView[] = [];
    for (const f of rows) {
      const all = await this.jobs.find({
        where: { folderId: f.id },
        select: ['status'],
      });
      views.push(
        this.toView(
          f,
          all.map((j) => j.status),
        ),
      );
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
