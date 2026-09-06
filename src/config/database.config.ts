import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ImportJobEntity } from '../game-importer/entities/import-job.entity';

export function databaseConfig(): TypeOrmModuleOptions {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    return {
      type: 'postgres',
      url: databaseUrl,
      entities: [ImportJobEntity],
      synchronize: true,
    };
  }
  return {
    type: 'sqlite',
    database: process.env.SQLITE_PATH ?? './data/app.sqlite',
    entities: [ImportJobEntity],
    synchronize: true,
  };
}
