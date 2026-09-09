import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A named group of imported games ("folder"). Folders are organizational
 * only: they partition jobs (and the console view) into collections; the
 * packages themselves still live under the shared storage root, each in
 * its own <job-id> directory.
 */
@Entity('game_folders')
export class GameFolderEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** Operator-chosen display name, unique per row (not per user). */
  @Index({ unique: true })
  @Column('text')
  name!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
