import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class BatchImportDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(25)
  @IsUrl({ require_protocol: true }, { each: true })
  sourceUrls!: string[];

  /** Optional folder to file the new jobs under. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  folderId?: string;
}
