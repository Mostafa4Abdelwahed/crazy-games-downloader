import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GameImporterModule } from './game-importer/game-importer.module';
import { databaseConfig } from './config/database.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    TypeOrmModule.forRootAsync({
      useFactory: () => databaseConfig(),
    }),
    GameImporterModule,
  ],
})
export class AppModule {}
