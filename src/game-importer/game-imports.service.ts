import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ImportJobEntity } from './entities/import-job.entity';
import { SourcePolicyService } from './core/source-policy';
import { ImportQueueService } from './queue/import.queue';
import { ImportJob, ImportJobLogEntry } from './core/types';
import { DiagnosticLevel, ImportDiagnostic } from './core/diagnostics';

const LEVELS: DiagnosticLevel[] = ['info', 'warning', 'error'];

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
export class GameImportsService {
  constructor(
    @InjectRepository(ImportJobEntity)
    private readonly jobs: Repository<ImportJobEntity>,
    private readonly policy: SourcePolicyService,
    private readonly queue: ImportQueueService,
  ) {}

  async create(sourceUrl: string): Promise<ImportJob> {
    // Validate SourcePolicy BEFORE creating/enqueueing anything to download.
    try {
      this.policy.assertAllowed(sourceUrl);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const entity = this.jobs.create({
      id: randomUUID(),
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
    return toJob(saved);
  }

  async get(id: string): Promise<ImportJob> {
    const e = await this.jobs.findOne({ where: { id } });
    if (!e) throw new NotFoundException(`Import job not found: ${id}`);
    return toJob(e);
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
