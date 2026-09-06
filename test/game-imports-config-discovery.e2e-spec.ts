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
const UNITY_FIXTURES = path.join(
  __dirname,
  '..',
  'src',
  'game-importer',
  'engines',
  'unity',
  'fixtures',
);
const read = (name: string): Buffer =>
  fs.readFileSync(path.join(FIXTURES, name));

const PORTAL = 'https://portal.crazygames.com/game/fixture-shell';
const FRAME = 'https://games.sub.crazygames.com/en_US/fixture-racer/index.html';
const FILES = 'https://files.sub.crazygames.com/fixture-racer/77/Build';

/**
 * Deterministic replica of the real JS-bootstrapped Unity flow (M3.1):
 * portal page with delivery JSON -> adapter resolves game document +
 * loader/build assets -> frame shell WITHOUT any static <script src> ->
 * loader + config resolved purely from adapter hints -> Brotli assets ->
 * packaged entry with generated local bootstrap.
 */
const siteMap: Record<string, Buffer> = {
  [PORTAL]: read('portal-delivery-config.html'),
  [FRAME]: read('shell-frame.html'),
  [`${FILES}/fp.loader.js`]: fs.readFileSync(
    path.join(UNITY_FIXTURES, 'generic-loader.stub.js'),
  ),
  [`${FILES}/fp.data.br`]: zlib.brotliCompressSync(
    Buffer.from('SHELL-DATA'.repeat(50)),
  ),
  [`${FILES}/fp.framework.js.br`]: zlib.brotliCompressSync(
    Buffer.from('SHELL-FRAMEWORK'),
  ),
  [`${FILES}/fp.wasm.br`]: zlib.brotliCompressSync(Buffer.from('SHELL-WASM')),
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

describe('M3.1 config discovery end to end (JS-bootstrapped frame)', () => {
  let app: INestApplication;
  let jobs: Repository<ImportJobEntity>;

  beforeAll(async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-cfg-'));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-cfg-'));
    process.env.SOURCE_ALLOWED_HOSTS =
      'portal.crazygames.com,games.sub.crazygames.com,files.sub.crazygames.com';
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
        throw new Error(
          `Timed out waiting for ${want}, now=${e.status} (${e.error})`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('imports a JS-bootstrapped Unity build with zero static config', async () => {
    const created = await request(app.getHttpServer())
      .post('/game-imports')
      .send({ sourceUrl: PORTAL })
      .expect(201);
    expect(created.body.status).toBe('queued');
    const done = await waitFor(created.body.id, ['completed', 'failed']);
    expect(done.status).toBe('completed');
    expect(done.detectedEngine).toBe('unity');

    const pkgRoot = done.packageUrl as string;
    const buildFiles = fs.readdirSync(path.join(pkgRoot, 'Build'));
    // Brotli assets decompressed to real filenames (no .br leftovers).
    expect(buildFiles.join(',')).toMatch(/fp\.loader\.js/);
    expect(buildFiles.join(',')).toMatch(/fp\.wasm/);
    expect(buildFiles.join(',')).toMatch(/fp\.data/);
    expect(buildFiles.join(',')).not.toMatch(/\.br/);
    expect(
      fs.readFileSync(path.join(pkgRoot, 'Build', 'fp.wasm'), 'utf8'),
    ).toBe('SHELL-WASM');

    // Generated local bootstrap: canvas + loader tag + localized config.
    const index = fs.readFileSync(path.join(pkgRoot, 'index.html'), 'utf8');
    expect(index).toMatch(/<canvas[^>]*id="unity-canvas"/);
    expect(index).toMatch(/<script src="Build\/fp\.loader\.js"><\/script>/);
    expect(index).toMatch(/createUnityInstance\(/);
    expect(index).toMatch(/dataUrl:\s*"Build\/fp\.data"/);
    expect(index).toMatch(/frameworkUrl:\s*"Build\/fp\.framework\.js"/);
    expect(index).toMatch(/codeUrl:\s*"Build\/fp\.wasm"/);
    // No remote build URLs leak into the runnable entry config.
    expect(index).not.toMatch(
      /files\.sub\.crazygames\.com\/[^"]*\.(wasm|data|framework\.js)/,
    );
    // Fully offline entry: no remote scripts whatsoever, so no ad/tracker
    // bootstrap can leak into the package.
    expect(index).not.toMatch(/<script[^>]+src="https?:/i);
    expect(index).not.toMatch(/src="http/i);

    // Discovery diagnostics trace the A->B->C chain.
    const job = await request(app.getHttpServer())
      .get(`/game-imports/${created.body.id}`)
      .expect(200);
    const codes = (job.body.diagnostics ?? []).map(
      (d: { code: string }) => d.code,
    );
    expect(codes).toContain('UNITY_CONFIG_DISCOVERY_STARTED');
    expect(codes).toContain('UNITY_CONFIG_FROM_ADAPTER_HINTS');
    expect(codes).toContain('UNITY_ENTRY_BOOTSTRAP_GENERATED');
    expect(codes).toContain('BROTLI_DECOMPRESSED');
    expect(job.body.errorCode).toBeNull();
  });
});
