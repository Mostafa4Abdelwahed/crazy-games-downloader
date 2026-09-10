import { IsIn, IsString } from 'class-validator';

/**
 * Body for the admin's manual verdict on a finished game
 * (`POST /game-imports/:id/review`).
 */
export class ReviewJobDto {
  /** `approved` = game works, `rejected` = game is broken. */
  @IsString()
  @IsIn(['approved', 'rejected'])
  status!: string;
}
