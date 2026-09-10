import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * A locally-served game (`python -m http.server` started from the
 * console's Start button). Persisted so a server restart can find and
 * kill orphaned processes instead of forgetting them: on boot every row
 * is reconciled (orphan killed if its port still answers, row dropped).
 */
@Entity('run_servers')
export class RunServerEntity {
  /** The import job this server was started for. */
  @PrimaryColumn('uuid')
  jobId!: string;

  @Column('int')
  port!: number;

  /** OS pid of the python process (null when the launcher hides it). */
  @Column('int', { nullable: true })
  pid!: number | null;

  @Column('text')
  url!: string;

  /** Package directory the server is rooted at. */
  @Column('text')
  root!: string;

  @CreateDateColumn()
  startedAt!: Date;
}
