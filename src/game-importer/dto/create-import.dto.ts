import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateImportDto {
  @IsUrl({ require_protocol: true })
  sourceUrl!: string;

  /** Optional folder to file the new job under. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  folderId?: string;
}
