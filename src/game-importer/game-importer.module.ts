import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ImportJobEntity } from './entities/import-job.entity';
import { GameFolderEntity } from './entities/game-folder.entity';
import { RunServerEntity } from './entities/run-server.entity';
import { GameImportsController } from './game-imports.controller';
import { ConsoleController } from './console/console.controller';
import { GameImportsService } from './game-imports.service';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { FoldersController } from './folders/folders.controller';
import { FoldersService } from './folders/folders.service';
import { SourcePolicyService } from './core/source-policy';
import { SecureDownloader } from './core/downloader';
import { SecureExtractor } from './core/extractor';
import { PackageValidator } from './core/validator';
import { CompositeDetector } from './core/detector';
import { GameImporterService } from './core/importer';
import { UnityDetector } from './engines/unity/unity.detector';
import { UnityLoaderParser } from './engines/unity/unity.loader-parser';
import { UnityAssetResolver } from './engines/unity/unity.asset-resolver';
import { UnityConfigDiscovery } from './engines/unity/unity.config-discovery';
import { UnityDecompressor } from './engines/unity/unity.decompressor';
import { UnityStreamingAssetsDiscovery } from './engines/unity/unity.streaming-assets-discovery';
import { UnityValidator } from './engines/unity/unity.validator';
import { UnityImporter } from './engines/unity/unity.importer';
import { GenericHtml5Importer } from './engines/generic-html5.importer';
import { GameEngineImporter } from './core/types';
import { ImportQueueService } from './queue/import.queue';
import { ImportWorker } from './queue/import.worker';
import { LocalStorage } from './storage/local.storage';
import { StorageFactory } from './storage/storage.factory';
import { SourceRegistry } from './sources/source-registry';
import { AuthorizedSourcePolicy } from './sources/authorized-source-policy';
import { CrazyGamesParser } from './sources/crazygames/crazygames.parser';
import { CrazyGamesSourceAdapter } from './sources/crazygames/crazygames.source';
import { GameSourceAdapter } from './sources/source.interface';
import { LocalPackageServer } from './runtime/local-package-server';
import { PlaywrightRuntimeValidator } from './runtime/playwright-runtime-validator';
import {
  GAME_BROWSER_OPENER,
  GAME_LOCAL_SERVER,
  openBrowser,
  launchPythonHttpServer,
} from './game-imports.service';

const ENGINE_COLLECTION = 'ENGINE_COLLECTION';
const SOURCE_ADAPTER_COLLECTION = 'SOURCE_ADAPTER_COLLECTION';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ImportJobEntity,
      GameFolderEntity,
      RunServerEntity,
    ]),
  ],
  // SettingsController must be registered BEFORE GameImportsController:
  // its literal `/game-imports/settings` routes would otherwise be shadowed
  // by the dynamic `GET /game-imports/:id` route.
  controllers: [
    SettingsController,
    GameImportsController,
    ConsoleController,
    FoldersController,
  ],
  providers: [
    GameImportsService,
    SettingsService,
    FoldersService,
    GameImporterService,
    {
      provide: GAME_BROWSER_OPENER,
      useValue: openBrowser,
    },
    {
      provide: GAME_LOCAL_SERVER,
      useValue: launchPythonHttpServer,
    },
    SourcePolicyService,
    SecureDownloader,
    SecureExtractor,
    PackageValidator,
    UnityDetector,
    UnityLoaderParser,
    UnityAssetResolver,
    UnityConfigDiscovery,
    UnityDecompressor,
    UnityStreamingAssetsDiscovery,
    UnityValidator,
    UnityImporter,
    GenericHtml5Importer,
    LocalStorage,
    StorageFactory,
    ImportQueueService,
    ImportWorker,
    AuthorizedSourcePolicy,
    CrazyGamesParser,
    CrazyGamesSourceAdapter,
    LocalPackageServer,
    PlaywrightRuntimeValidator,
    {
      provide: ENGINE_COLLECTION,
      useFactory: (unity: UnityImporter, generic: GenericHtml5Importer) =>
        [unity, generic] as GameEngineImporter[],
      inject: [UnityImporter, GenericHtml5Importer],
    },
    {
      provide: CompositeDetector,
      useFactory: (engines: GameEngineImporter[]) =>
        new CompositeDetector(engines),
      inject: [ENGINE_COLLECTION],
    },
    {
      provide: 'ENGINES',
      useExisting: ENGINE_COLLECTION,
    },
    {
      provide: SOURCE_ADAPTER_COLLECTION,
      useFactory: (crazygames: CrazyGamesSourceAdapter) =>
        [crazygames] as GameSourceAdapter[],
      inject: [CrazyGamesSourceAdapter],
    },
    {
      provide: 'SOURCE_ADAPTERS',
      useExisting: SOURCE_ADAPTER_COLLECTION,
    },
    {
      provide: SourceRegistry,
      useFactory: (adapters: GameSourceAdapter[]) =>
        new SourceRegistry(adapters),
      inject: [SOURCE_ADAPTER_COLLECTION],
    },
  ],
  exports: [GameImportsService],
})
export class GameImporterModule implements OnModuleInit {
  constructor(
    private readonly queue: ImportQueueService,
    private readonly worker: ImportWorker,
  ) {}

  onModuleInit() {
    // Wire worker processor (memory driver calls it directly; BullMQ
    // external workers can import ImportWorker too — see README).
    this.queue.setProcessor((jobId: string) => this.worker.process(jobId));
  }
}
