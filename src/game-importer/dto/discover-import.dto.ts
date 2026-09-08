import { IsUrl, MaxLength } from 'class-validator';

export class DiscoverImportDto {
  @MaxLength(500)
  @IsUrl({ require_protocol: true })
  pageUrl!: string;
}
