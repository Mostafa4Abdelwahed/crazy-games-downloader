import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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
