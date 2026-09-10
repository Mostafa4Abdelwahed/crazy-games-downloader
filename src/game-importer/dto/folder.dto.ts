import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateFolderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;
}

export class RenameFolderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;
}

export class AssignJobDto {
  @IsString()
  @IsNotEmpty()
  jobId!: string;
}

/** Optional folder scoping for job creation. */
export class FolderScopeDto {
  @IsOptional()
  @IsString()
  folderId?: string;
}

/** One game entry inside an imported backup file. */
export class BackupGameDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  @IsUrl({ require_protocol: true })
  sourceUrl!: string;
}

/** One folder group inside an imported backup file. */
export class BackupFolderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => BackupGameDto)
  games!: BackupGameDto[];
}

/** Body for POST /folders/import (a file produced by GET /folders/export). */
export class ImportBackupDto {
  @IsOptional()
  @IsString()
  exportedAt?: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BackupFolderDto)
  folders!: BackupFolderDto[];
}
