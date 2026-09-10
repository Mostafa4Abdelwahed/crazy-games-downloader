import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CreateImportDto } from './dto/create-import.dto';
import { BatchImportDto } from './dto/batch-import.dto';
import { DiscoverImportDto } from './dto/discover-import.dto';
import { FolderScopeDto } from './dto/folder.dto';
import { RetryJobsDto } from './dto/retry-jobs.dto';
import { ReviewJobDto } from './dto/review-job.dto';
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
    return this.service.create(dto.sourceUrl, dto.folderId, dto.force);
  }

  @Post('batch')
  createBatch(@Body() dto: BatchImportDto) {
    return this.service.createBatch(dto.sourceUrls, dto.folderId, dto.force);
  }

  @Post('retry-failed')
  @HttpCode(200)
  retryFailed(@Body() dto: FolderScopeDto) {
    return this.service.retryFailed(dto.folderId);
  }

  @Post('retry')
  @HttpCode(200)
  retryJobs(@Body() dto: RetryJobsDto) {
    return this.service.retryJobs(dto.jobIds);
  }

  @Post(':id/reimport')
  @HttpCode(200)
  reimport(@Param('id') id: string) {
    return this.service.reimport(id);
  }

  @Post('discover')
  @HttpCode(200)
  discover(@Body() dto: DiscoverImportDto) {
    return this.service.discoverGames(dto.pageUrl);
  }

  @Get()
  list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('folderId') folderId?: string,
    @Query('status') status?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
    @Query('q') q?: string,
    @Query('review') review?: string,
  ) {
    const p = page === undefined ? 1 : Number(page);
    const n = limit === undefined ? 50 : Number(limit);
    // folderId: a real folder id, 'none' (ungrouped only), or omitted (all).
    const scope =
      folderId === undefined || folderId === '' ? undefined : folderId;
    const sortKey =
      sort === 'seq' || sort === 'status' || sort === 'progress'
        ? sort
        : sort === 'createdAt' || sort === 'updatedAt'
          ? 'updatedAt'
          : 'updatedAt';
    return this.service.list(
      Number.isFinite(p) ? p : 1,
      Number.isFinite(n) ? n : 50,
      scope,
      status || null,
      sortKey,
      dir === 'ASC' || dir === 'asc' ? 'ASC' : 'DESC',
      q || null,
      review || null,
    );
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }

  @Post(':id/review')
  @HttpCode(200)
  review(@Param('id') id: string, @Body() dto: ReviewJobDto) {
    return this.service.setReviewStatus(id, dto.status);
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
