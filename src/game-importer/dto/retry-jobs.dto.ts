import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/**
 * Retry explicit job ids in place (failed/cancelled rows go back to
 * queued; anything else is reported as skipped, never touched).
 */
export class RetryJobsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  jobIds!: string[];
}
