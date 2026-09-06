import { IsUrl } from 'class-validator';

export class CreateImportDto {
  @IsUrl({ require_protocol: true })
  sourceUrl!: string;
}
