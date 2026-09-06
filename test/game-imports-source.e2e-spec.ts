import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { GameImporterModule } from '../src/game-importer/game-importer.module';
import { ImportJobEntity } from '../src/game-importer/entities/import-job.entity';
import { SecureDownloader } from '../src/game-importer/core/downloader';

const FIXTURES = path.join(
  __dirname,
  '..',
  'src',
  'game-importer',
  'sources',
  'crazygames',
  'fixtures',
);
const read = (name: string): Buffer =>
  fs.readFileSync(path.join(FIXTURES, name));

const GAME = 'https://games.crazygames.com';

function loaderJs(data: string, framework: string, code: string): Buffer {
  return Buffer.from(
    `var config = { dataUrl: "${data}", frameworkUrl: "${framework}", codeUrl: "${code}" };`,
  );
}

/**
 * Local fixture-backed site map. No test depends on live third-party sites:
 * every URL the pipeline fetches is served from these in-memory fixtures.
 */
const siteMap: Record<string, Buffer> = {
  // Standard Unity layout
  'https://www.crazygames.com/game/space-adventure': read('unity-page.html'),
  [`${GAME}/en_US/space-adventure/index.html`]: read('unity-frame.html'),
  [`${GAME}/en_US/space-adventure/Build/space-adventure.loader.js`]: loaderJs(
    'space-adventure.data',
    'space-adventure.framework.js',
    'space-adventure.wasm',
  ),
  [`${GAME}/en_US/space-adventure/Build/space-adventure.data`]: Buffer.from(
    'UNITY-DATA'.repeat(50),
  ),
  [`${GAME}/en_US/space-adventure/Build/space-adventure.framework.js`]:
    Buffer.from('UNITY-FRAMEWORK'),
  [`${GAME}/en_US/space-adventure/Build/space-adventure.wasm`]:
    Buffer.from('UNITY-WASM'),
  // Alt filenames + nested layout
  'https://www.crazygames.com/game/ninja-run': read('unity-alt-page.html'),
  [`${GAME}/en_US/ninja-run/index.html`]: read('unity-alt-frame.html'),
  [`${GAME}/en_US/ninja-run/webgl/Build/ninja-run.loader.js`]: loaderJs(
    'ninja-run.data',
    'ninja-run.framework.js',
    'ninja-run.wasm',
  ),
  [`${GAME}/en_US/ninja-run/webgl/Build/ninja-run.data`]: Buffer.from(
    'NINJA-DATA'.repeat(50),
  ),
  [`${GAME}/en_US/ninja-run/webgl/Build/ninja-run.framework.js`]:
    Buffer.from('NINJA-FRAMEWORK'),
  [`${GAME}/en_US/ninja-run/webgl/Build/ninja-run.wasm`]:
    Buffer.from('NINJA-WASM'),
  // Brotli-compressed Unity build (served compressed, like a real CDN)
  'https://www.crazygames.com/game/pixel-racer': read('unity-br-page.html'),
  [`${GAME}/en_US/pixel-racer/index.html`]: read('unity-br-frame.html'),
  [`${GAME}/en_US/pixel-racer/Build/pixel-racer.loader.js`]: loaderJs(
    'pixel-racer.data.br',
    'pixel-racer.framework.js.br',
    'pixel-racer.wasm.br',
  ),
  [`${GAME}/en_US/pixel-racer/Build/pixel-racer.data.br`]:
    zlib.brotliCompressSync(Buffer.from('RACER-DATA'.repeat(50))),
  [`${GAME}/en_US/pixel-racer/Build/pixel-racer.framework.js.br`]:
    zlib.brotliCompressSync(Buffer.from('RACER-FRAMEWORK')),
  [`${GAME}/en_US/pixel-racer/Build/pixel-racer.wasm.br`]:
    zlib.brotliCompressSync(Buffer.from('RACER-WASM')),
  // Generic HTML5 (non-Unity) layout
  'https://www.crazygames.com/game/jewel-quest': read('html5-page.html'),
  [`${GAME}/en_US/jewel-quest/index.html`]: read('html5-frame.html'),
};

function fakeDownloader(map: Record<string, Buffer>) {
  return {
    fetchBuffer: async (url: string) => {
      const body = map[url];
      if (!body) throw new Error(`Fake 404 for ${url}`);
      return {
        finalUrl: url,
        status: 200,
        contentType: 'text/html',
        body,
        redirected: false,
      };
    },
    downloadToFile: async () => ({ finalUrl: '', bytes: 0 }),
  };
}

describe('Game imports via source adapter (CrazyGames fixtures)', () => {
  let app: INestApplication;
  let jobs: Repository<ImportJobEntity>;

  beforeAll(async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-src-'));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-src-'));
    process.env.SOURCE_ALLOWED_HOSTS =
      'www.crazygames.com,games.crazygames.com';
    process.env.ALLOW_ANY_HTTPS = 'false';
    process.env.QUEUE_DRIVER = 'memory';
    process.env.IMPORT_WORK_DIR = workDir;
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_ROOT = storeDir;

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [ImportJobEntity],
          synchronize: true,
        }),
        GameImporterModule,
      ],
    })
      .overrideProvider(SecureDownloader)
      .useValue(fakeDownloader(siteMap))
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    jobs = module.get<Repository<ImportJobEntity>>(
      getRepositoryToken(ImportJobEntity),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  async function waitFor(id: string, want: string[], timeoutMs = 20000) {
    const start = Date.now();
    for (;;) {
      const e = await jobs.findOneOrFail({ where: { id } });
      if (want.includes(e.status)) return e;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for ${want}, now=${e.status}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function importAndWait(sourceUrl: string) {
    const created = await request(app.getHttpServer())
      .post('/game-imports')
      .send({ sourceUrl })
      .expect(201);
    expect(created.body.status).toBe('queued');
    return waitFor(created.body.id, ['completed', 'failed']);
  }

  it('POST /game-imports -> adapter -> detection -> unity -> completed', async () => {
    const done = await importAndWait(
      'https://www.crazygames.com/game/space-adventure',
    );
    expect(done.status).toBe('completed');
    expect(done.detectedEngine).toBe('unity');
    expect(done.packageUrl).toBeTruthy();
    const pkgRoot = done.packageUrl as string;
    expect(fs.existsSync(path.join(pkgRoot, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(pkgRoot, 'manifest.json'))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pkgRoot, 'manifest.json'), 'utf8'),
    );
    expect(manifest.engine).toBe('unity');
    const buildFiles = fs.readdirSync(path.join(pkgRoot, 'Build'));
    expect(buildFiles.join(',')).toMatch(/space-adventure\.loader\.js/);
    expect(buildFiles.join(',')).toMatch(/space-adventure\.wasm/);
    expect(buildFiles.join(',')).toMatch(/space-adventure\.data/);
  });

  it('imports Unity builds with different filenames/layouts', async () => {
    const done = await importAndWait(
      'https://www.crazygames.com/game/ninja-run',
    );
    expect(done.status).toBe('completed');
    expect(done.detectedEngine).toBe('unity');
    const buildFiles = fs.readdirSync(
      path.join(done.packageUrl as string, 'Build'),
    );
    expect(buildFiles.join(',')).toMatch(/ninja-run\.loader\.js/);
    expect(buildFiles.join(',')).toMatch(/ninja-run\.wasm/);
  });

  it('decompresses Brotli Unity builds end to end', async () => {
    const done = await importAndWait(
      'https://www.crazygames.com/game/pixel-racer',
    );
    expect(done.status).toBe('completed');
    const buildFiles = fs.readdirSync(
      path.join(done.packageUrl as string, 'Build'),
    );
    expect(buildFiles.join(',')).toMatch(/pixel-racer\.wasm/);
    expect(buildFiles.join(',')).not.toMatch(/\.br/);
    const wasm = fs.readFileSync(
      path.join(done.packageUrl as string, 'Build', 'pixel-racer.wasm'),
      'utf8',
    );
    expect(wasm).toBe('RACER-WASM');
  });

  it('does not force non-Unity sources into the Unity importer', async () => {
    const done = await importAndWait(
      'https://www.crazygames.com/game/jewel-quest',
    );
    // Generic HTML5 packaging is out of scope -> detection must fail
    // cleanly (unknown engine), NOT with a Unity-specific error.
    expect(done.status).toBe('failed');
    expect(done.error ?? '').toMatch(/detection/i);
    expect(done.error ?? '').not.toMatch(/loader script not found/i);
  });
});
