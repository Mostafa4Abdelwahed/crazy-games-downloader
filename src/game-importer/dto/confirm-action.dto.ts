import { IsString } from 'class-validator';

/** Body for every destructive Settings action (danger zone). */
export class ConfirmActionDto {
  /** Must be the exact confirmation phrase, checked server-side. */
  @IsString()
  confirm!: string;
}
