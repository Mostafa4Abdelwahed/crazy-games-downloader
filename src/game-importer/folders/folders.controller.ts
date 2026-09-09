import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  AssignJobDto,
  CreateFolderDto,
  RenameFolderDto,
} from '../dto/folder.dto';
import { FoldersService } from './folders.service';

/**
 * Folders API for the home page: named groups of games, each with its
 * own console. Deletion never deletes jobs or packages — jobs fall
 * back to the ungrouped collection.
 */
@Controller('folders')
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get()
  list(@Query('storage') storage?: string) {
    return this.folders.list(storage === 'true' || storage === '1');
  }

  // NOTE: static route registered before `:id` so "export" is never
  // captured as a folder id (same shadowing trap as /console/settings).
  @Get('export')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async exportBackup(@Res() res: Response) {
    const backup = await this.folders.exportBackup();
    const day = backup.exportedAt.slice(0, 10);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="game-folders-backup-${day}.json"`,
    );
    res.send(JSON.stringify(backup, null, 2));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.folders.get(id);
  }

  @Post()
  create(@Body() dto: CreateFolderDto) {
    return this.folders.create(dto.name);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() dto: RenameFolderDto) {
    return this.folders.rename(id, dto.name);
  }

  @Delete(':id')
  @HttpCode(200)
  async delete(@Param('id') id: string) {
    return this.folders.delete(id);
  }

  @Post(':id/assign')
  @HttpCode(200)
  assign(@Param('id') id: string, @Body() dto: AssignJobDto) {
    return this.folders.assignJob(dto.jobId, id);
  }

  @Post('unassign')
  @HttpCode(200)
  unassign(@Body() dto: AssignJobDto) {
    return this.folders.assignJob(dto.jobId, null);
  }
}
