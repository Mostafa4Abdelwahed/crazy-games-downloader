import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ImportJobEntity } from '../game-importer/entities/import-job.entity';
import { GameFolderEntity } from '../game-importer/entities/game-folder.entity';

export function databaseConfig(): TypeOrmModuleOptions {
  const databaseUrl = process.env.DATABASE_URL;
  const entities = [ImportJobEntity, GameFolderEntity];
  if (databaseUrl) {
    return {
      type: 'postgres',
      url: databaseUrl,
      entities,
      synchronize: true,
    };
  }
  return {
    type: 'sqlite',
    database: process.env.SQLITE_PATH ?? './data/app.sqlite',
    entities,
    synchronize: true,
  };
}
