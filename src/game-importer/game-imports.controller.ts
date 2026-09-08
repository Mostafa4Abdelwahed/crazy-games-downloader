import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CreateImportDto } from './dto/create-import.dto';
import { BatchImportDto } from './dto/batch-import.dto';
import { DiscoverImportDto } from './dto/discover-import.dto';
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

  @Post('batch')
  createBatch(@Body() dto: BatchImportDto) {
    return this.service.createBatch(dto.sourceUrls);
  }

  @Post('discover')
  @HttpCode(200)
  discover(@Body() dto: DiscoverImportDto) {
    return this.service.discoverGames(dto.pageUrl);
  }

  @Get()
  list(@Query('page') page?: string, @Query('limit') limit?: string) {
    const p = page === undefined ? 1 : Number(page);
    const n = limit === undefined ? 50 : Number(limit);
    return this.service.list(
      Number.isFinite(p) ? p : 1,
      Number.isFinite(n) ? n : 50,
    );
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

  @Post(':id/run')
  @HttpCode(200)
  run(@Param('id') id: string) {
    return this.service.run(id);
  }

  @Post(':id/stop')
  @HttpCode(200)
  stop(@Param('id') id: string) {
    return this.service.stop(id);
  }
}
