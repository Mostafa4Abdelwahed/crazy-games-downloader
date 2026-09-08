import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUrl } from 'class-validator';

export class BatchImportDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(25)
  @IsUrl({ require_protocol: true }, { each: true })
  sourceUrls!: string[];
}
