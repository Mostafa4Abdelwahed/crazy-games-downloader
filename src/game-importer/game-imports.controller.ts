import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CreateImportDto } from './dto/create-import.dto';
import { GameImportsService } from './game-imports.service';

/**
 * Public import API.
 * NOTE: games are served from storage on an isolated origin (see README);
 * this controller never executes imported JavaScript.
 */
@Controller('game-imports')
export class GameImportsController {
  constructor(private readonly service: GameImportsService) {}

  @Post()
  create(@Body() dto: CreateImportDto) {
    return this.service.create(dto.sourceUrl);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }

  @Get(':id/logs')
  logs(@Param('id') id: string) {
    return this.service.logs(id);
  }
}
