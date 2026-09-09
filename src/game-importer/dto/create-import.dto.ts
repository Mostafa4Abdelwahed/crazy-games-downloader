import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class CreateImportDto {
  @IsUrl({ require_protocol: true })
  sourceUrl!: string;

  /** Optional folder to file the new job under. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  folderId?: string;

  /**
   * Skip the global dedup check and start a fresh run even when the game
   * already exists (explicit Re-import intent).
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
