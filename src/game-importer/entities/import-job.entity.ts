import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ImportState } from '../core/types';

@Entity('import_jobs')
export class ImportJobEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('text')
  sourceUrl!: string;

  @Column('text', { default: 'queued' })
  status!: ImportState;

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

  @Column('simple-json', { nullable: true })
  logs!: { at: string; level: string; message: string; step?: string }[] | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
