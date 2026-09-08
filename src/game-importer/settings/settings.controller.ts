import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ConfirmActionDto } from '../dto/confirm-action.dto';
import { SettingsService } from './settings.service';

/**
 * Settings API for the management console: a read-only view of the
 * environment-driven project settings plus guarded destructive actions
 * (danger zone). Every destructive call must carry the confirmation
 * phrase and is re-validated server-side.
 */
@Controller('game-imports/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  view() {
    return this.settings.view();
  }

  @Post('reset-all')
  @HttpCode(200)
  resetAll(@Body() dto: ConfirmActionDto) {
    return this.settings.resetAll(dto.confirm);
  }

  @Post('clear-jobs')
  @HttpCode(200)
  clearJobs(@Body() dto: ConfirmActionDto) {
    return this.settings.clearJobs(dto.confirm);
  }

  @Post('clear-work')
  @HttpCode(200)
  clearWork(@Body() dto: ConfirmActionDto) {
    return this.settings.clearWork(dto.confirm);
  }

  @Post('clear-packages')
  @HttpCode(200)
  clearPackages(@Body() dto: ConfirmActionDto) {
    return this.settings.clearPackages(dto.confirm);
  }
}
