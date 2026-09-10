import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ImportState, ReviewStatus } from '../core/types';

@Entity('import_jobs')
export class ImportJobEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /**
   * Human-friendly sequential job number (#1, #2, …) assigned at
   * creation. Purely cosmetic for the console table; the UUID id stays
   * the real identifier everywhere else.
   */
  @Index({ unique: true })
  @Column('integer', { nullable: true })
  seq!: number | null;

  @Column('text')
  sourceUrl!: string;

  /**
   * Normalized URL key used to deduplicate submissions: re-pressing the
   * same game reuses an in-flight job or starts an update (new run) after
   * a terminal one, instead of creating duplicate rows.
   */
  @Index()
  @Column('text', { default: '' })
  sourceKey!: string;

  @Column('text', { default: 'queued' })
  status!: ImportState;

  /**
   * Manual admin verdict on the imported game (`pending` until reviewed).
   * Written only by the explicit review endpoint — the import pipeline
   * never touches it, so it survives retries and status transitions.
   */
  @Column('text', { default: 'pending' })
  reviewStatus!: ReviewStatus;

  @Column('float', { default: 0 })
  progress!: number;

  @Column('text', { nullable: true })
  detectedEngine!: string | null;

  @Column('int', { default: 0 })
  downloadedFiles!: number;

  @Column('int', { default: 0 })
  totalFiles!: number;

  @Column('text', { nullable: true })
  currentStep!: string | null;

  @Column('text', { nullable: true })
  error!: string | null;

  /**
   * Stable machine-readable failure code (M3), e.g. RUNTIME_TIMEOUT,
   * MISSING_ASSET, IMPORT_FAILED. Null unless the job failed.
   */
  @Column('text', { nullable: true })
  errorCode!: string | null;

  /**
   * Sanitized structured diagnostics collected during the run (M3).
   * Secrets are redacted at collection time; safe to expose via the API.
   * (Structural type mirrors ImportDiagnostic but stays TypeORM
   * simple-json friendly.)
   */
  @Column('simple-json', { nullable: true })
  diagnostics!: Array<{
    level: string;
    code: string;
    message: string;
    details?: Record<string, any>;
  }> | null;

  @Column('text', { nullable: true })
  packageUrl!: string | null;

  /**
   * Owning folder (organizational grouping for the console). Null means
   * the job lives in the default/ungrouped collection (shown on a
   * fallback console, not on any folder page).
   */
  @Index()
  @Column('uuid', { nullable: true })
  folderId!: string | null;

  @Column('simple-json', { nullable: true })
  logs!: { at: string; level: string; message: string; step?: string }[] | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
