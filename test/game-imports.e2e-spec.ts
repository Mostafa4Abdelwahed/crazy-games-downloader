import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GameImporterModule } from '../src/game-importer/game-importer.module';
import { ImportJobEntity } from '../src/game-importer/entities/import-job.entity';
import { GameFolderEntity } from '../src/game-importer/entities/game-folder.entity';
import { RunServerEntity } from '../src/game-importer/entities/run-server.entity';
import { SecureDownloader } from '../src/game-importer/core/downloader';
import { ImportWorker } from '../src/game-importer/queue/import.worker';
import {
  GAME_BROWSER_OPENER,
  GAME_LOCAL_SERVER,
} from '../src/game-importer/game-imports.service';

const ENTRY_HTML = `<!doctype html><html><head><title>T</title></head><body>
<canvas id="unity-canvas"></canvas>
<script src="Build/test.loader.js"></script>
<script>createUnityInstance(document.querySelector("#unity-canvas"), {
  dataUrl: "Build/test.data",
  frameworkUrl: "Build/test.framework.js",
  codeUrl: "Build/test.wasm" });</script>
</body></html>`;

const LOADER_JS = `var config = { dataUrl: "test.data", frameworkUrl: "test.framework.js", codeUrl: "test.wasm" };`;

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

describe('Game imports integration', () => {
  let app: INestApplication;
  let testingModule: TestingModule;
  let jobs: Repository<ImportJobEntity>;
  let workDir: string;
  let storeDir: string;

  const base = 'https://partner.example/games/demo';
  // Distinct game URLs (same content) so each e2e test can create its own
  // game under the global dedup (one row per game URL, ever).
  const gameUrl = (n: number) => `https://partner.example/games/demo-${n}`;
  // NOTE: relative "Build/..." refs resolve against the *directory* of the
  // base URL (demo is treated as a file segment per WHATWG URL semantics).
  const siteMap: Record<string, Buffer> = {
    [base]: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/demo-1']: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/demo-2']: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/demo-3']: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/demo-4']: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/demo-5']: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/demo-6']: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/demo-7']: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/demo-8']: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/demo-9']: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/demo-10']: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/demo-11']: Buffer.from(ENTRY_HTML),
    ['https://partner.example/games/Build/test.loader.js']:
      Buffer.from(LOADER_JS),
    ['https://partner.example/games/Build/test.data']: Buffer.from(
      'DATA'.repeat(100),
    ),
    ['https://partner.example/games/Build/test.framework.js']:
      Buffer.from('FRAMEWORK'),
    ['https://partner.example/games/Build/test.wasm']: Buffer.from('WASM'),
  };
  // Loader-relative resolution: loader at Build/test.loader.js, config refs
  // "test.data" resolve against loader URL dir.

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-'));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
    process.env.SOURCE_ALLOWED_HOSTS = 'partner.example';
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
          entities: [ImportJobEntity, GameFolderEntity, RunServerEntity],
          synchronize: true,
        }),
        GameImporterModule,
      ],
    })
      .overrideProvider(SecureDownloader)
      .useValue(fakeDownloader(siteMap))
      .overrideProvider(GAME_BROWSER_OPENER)
      .useValue(() => null)
      .overrideProvider(GAME_LOCAL_SERVER)
      .useValue(async () => ({
        url: 'http://localhost:7000/',
        port: 7000,
        child: { kill: jest.fn() },
      }))
      .compile();
    testingModule = module;

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

  it('creates an import job via POST /game-imports', async () => {
    const res = await request(app.getHttpServer())
      .post('/game-imports')
      .send({ sourceUrl: base })
      .expect(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('queued');
    expect(res.body).toHaveProperty('progress');
    expect(res.body).toHaveProperty('downloadedFiles');
  });

  it('worker processes the job to completed and uploads storage', async () => {
    const created = await request(app.getHttpServer())
      .post('/game-imports')
      .send({ sourceUrl: base })
      .expect(201);
    const done = await waitFor(created.body.id, ['completed', 'failed']);
    expect(done.status).toBe('completed');
    expect(done.detectedEngine).toBe('unity');
    expect(done.packageUrl).toBeTruthy();

    // Storage upload contains normalized package
    const pkgRoot = done.packageUrl as string;
    expect(fs.existsSync(path.join(pkgRoot, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(pkgRoot, 'manifest.json'))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pkgRoot, 'manifest.json'), 'utf8'),
    );
    expect(manifest.engine).toBe('unity');
    expect(manifest.entryFile).toBe('index.html');
    const buildFiles = fs.readdirSync(path.join(pkgRoot, 'Build'));
    expect(buildFiles.join(',')).toMatch(/loader\.js/);
    expect(buildFiles.join(',')).toMatch(/\.wasm/);

    // Progress endpoint exposes status fields
    const got = await request(app.getHttpServer())
      .get(`/game-imports/${created.body.id}`)
      .expect(200);
    expect(got.body.detectedEngine).toBe('unity');
    expect(got.body.progress).toBe(100);
    // …plus the on-disk size of the stored package.
    expect(got.body.packageBytes).toBeGreaterThan(0);
    expect(got.body.packageFiles).toBeGreaterThan(0);
  });

  it('exposes logs', async () => {
    const created = await request(app.getHttpServer())
      .post('/game-imports')
      .send({ sourceUrl: base })
      .expect(201);
    await waitFor(created.body.id, ['completed', 'failed']);
    const logs = await request(app.getHttpServer())
      .get(`/game-imports/${created.body.id}/logs`)
      .expect(200);
    expect(Array.isArray(logs.body)).toBe(true);
    expect(logs.body.length).toBeGreaterThan(0);
  });

  it('serves a completed package via run and stops it', async () => {
    const created = await request(app.getHttpServer())
      .post('/game-imports')
      .send({ sourceUrl: base })
      .expect(201);
    const done = await waitFor(created.body.id, ['completed', 'failed']);
    expect(done.status).toBe('completed');
    const servers = testingModule.get<Repository<RunServerEntity>>(
      getRepositoryToken(RunServerEntity),
    );

    const run = await request(app.getHttpServer())
      .post(`/game-imports/${created.body.id}/run`)
      .expect(200);
    expect(run.body.url).toMatch(/^http:\/\/localhost:\d+\/$/);
    expect(run.body.port).toBeGreaterThan(0);
    // The running server is persisted so a restart can find it.
    const row = await servers.findOne({
      where: { jobId: created.body.id },
    });
    expect(row).toBeTruthy();
    expect(row?.port).toBe(run.body.port);

    // Double-start is idempotent (same server reused).
    const run2 = await request(app.getHttpServer())
      .post(`/game-imports/${created.body.id}/run`)
      .expect(200);
    expect(run2.body.url).toBe(run.body.url);

    const stop = await request(app.getHttpServer())
      .post(`/game-imports/${created.body.id}/stop`)
      .expect(200);
    expect(stop.body).toEqual({ url: run.body.url, stopped: true });
    // …and the persisted row is dropped with it.
    await expect(
      servers.findOne({ where: { jobId: created.body.id } }),
    ).resolves.toBeNull();
  });

  it('refuses run for a job with no completed package', async () => {
    await request(app.getHttpServer())
      .post(`/game-imports/${randomUUID()}/run`)
      .expect(404);
  });

  it('rejects non-allowlisted sources before queueing', async () => {
    await request(app.getHttpServer())
      .post('/game-imports')
      .send({ sourceUrl: 'https://evil.example/game' })
      .expect(400);
  });

  it('marks detection failures as failed with error info', async () => {
    const fake404 = {
      fetchBuffer: async () => {
        return {
          finalUrl: 'https://partner.example/empty',
          status: 200,
          contentType: 'text/html',
          body: Buffer.from('<html><body>nothing here</body></html>'),
          redirected: false,
        };
      },
      downloadToFile: async () => ({ finalUrl: '', bytes: 0 }),
    };
    const worker = app.get(ImportWorker);
    const orig = (worker as any).downloader;
    (worker as any).downloader = fake404;
    const created = await request(app.getHttpServer())
      .post('/game-imports')
      .send({ sourceUrl: 'https://partner.example/empty' })
      .expect(201);
    // Prevent memory-queue auto-run from using the real fake: wait for failure
    const done = await waitFor(created.body.id, ['failed'], 20000);
    expect(done.error).toBeTruthy();
    (worker as any).downloader = orig;
  });

  it('supports cancellation without completing', async () => {
    // Insert directly (no enqueue) so cancel wins the race deterministically.
    const repo = jobs;
    const e = repo.create({
      id: 'cancel-test-id',
      sourceUrl: base,
      status: 'queued',
      progress: 0,
      detectedEngine: null,
      downloadedFiles: 0,
      totalFiles: 0,
      currentStep: 'queued',
      error: null,
      packageUrl: null,
      logs: [],
    });
    await repo.save(e);
    await request(app.getHttpServer())
      .post('/game-imports/cancel-test-id/cancel')
      .expect(200)
      .expect((res) => {
        if (res.body.status !== 'cancelled') throw new Error('not cancelled');
      });
    const worker = app.get(ImportWorker);
    await worker.process('cancel-test-id');
    const after = await repo.findOneOrFail({ where: { id: 'cancel-test-id' } });
    expect(after.status).toBe('cancelled');
    expect(after.packageUrl).toBeNull();
  });

  describe('settings', () => {
    it('GET /game-imports/settings returns the grouped view without secrets', async () => {
      const res = await request(app.getHttpServer())
        .get('/game-imports/settings')
        .expect(200);
      expect(res.body.server).toBeDefined();
      expect(res.body.database.driver).toBe('sqlite');
      expect(res.body.queue.driver).toBe('memory');
      expect(res.body.paths.storageRoot).toBe(path.resolve(storeDir));
      expect(res.body.paths.workDir).toBe(path.resolve(workDir));
      expect(res.body.security.allowedHosts).toContain('partner.example');
      expect(typeof res.body.stats.jobs).toBe('number');
      expect(JSON.stringify(res.body)).not.toContain('redis://');
    });

    it('rejects destructive actions without the confirmation phrase', async () => {
      await request(app.getHttpServer())
        .post('/game-imports/settings/reset-all')
        .send({ confirm: 'nope' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/game-imports/settings/clear-jobs')
        .send({ confirm: '' })
        .expect(400);
      // Wrong-phrase attempts must not delete anything.
      expect(await jobs.count()).toBeGreaterThan(0);
    });

    it('reset-all wipes jobs, work dirs and packages after confirmation', async () => {
      // Ensure there is at least one completed package on disk.
      const created = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: base })
        .expect(201);
      await waitFor(created.body.id, ['completed', 'failed']);
      expect(fs.readdirSync(storeDir).length).toBeGreaterThan(0);

      const res = await request(app.getHttpServer())
        .post('/game-imports/settings/reset-all')
        .send({ confirm: 'DELETE' })
        .expect(200);
      expect(res.body.clearedJobs).toBeGreaterThan(0);
      expect(res.body.clearedPackages).toBeGreaterThan(0);
      expect(res.body.clearedWork).toBeGreaterThanOrEqual(0);
      expect(typeof res.body.stoppedServers).toBe('number');
      expect(res.body.failedPackages).toEqual([]);
      expect(await jobs.count()).toBe(0);
      expect(fs.readdirSync(storeDir)).toEqual([]);
      expect(fs.readdirSync(workDir)).toEqual([]);

      const after = await request(app.getHttpServer())
        .get('/game-imports/settings')
        .expect(200);
      expect(after.body.stats).toEqual({
        jobs: 0,
        packages: 0,
        workDirs: 0,
        packagesBytes: 0,
        workBytes: 0,
      });
    });

    it('serves the settings console page', async () => {
      const res = await request(app.getHttpServer())
        .get('/console/settings')
        .expect(200);
      expect(res.text).toContain('<!doctype html>');
      expect(res.text).toContain('Danger zone');
      expect(res.text).toContain('resetAllBtn');
    });

    it('clear-work and clear-packages work individually', async () => {
      const created = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: base })
        .expect(201);
      await waitFor(created.body.id, ['completed', 'failed']);
      fs.mkdirSync(path.join(workDir, 'leftover'), { recursive: true });

      const pkg = await request(app.getHttpServer())
        .post('/game-imports/settings/clear-packages')
        .send({ confirm: 'delete' })
        .expect(200);
      expect(pkg.body.cleared).toBeGreaterThan(0);
      expect(fs.readdirSync(storeDir)).toEqual([]);
      // Jobs survive a packages-only clear.
      expect(await jobs.count()).toBeGreaterThan(0);

      const work = await request(app.getHttpServer())
        .post('/game-imports/settings/clear-work')
        .send({ confirm: 'DELETE' })
        .expect(200);
      expect(work.body.cleared).toBeGreaterThanOrEqual(1);
      expect(fs.readdirSync(workDir)).toEqual([]);
    });

    it('clear-packages stops running game servers before deleting', async () => {
      const created = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(11) })
        .expect(201);
      const done = await waitFor(created.body.id, ['completed', 'failed']);
      expect(done.status).toBe('completed');

      // Start a server for it (mocked launcher, but tracked + persisted).
      await request(app.getHttpServer())
        .post(`/game-imports/${created.body.id}/run`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/game-imports/settings/clear-packages')
        .send({ confirm: 'DELETE' })
        .expect(200);
      expect(res.body.stoppedServers).toBeGreaterThanOrEqual(1);
      expect(res.body.failed).toEqual([]);
      expect(res.body.cleared).toBeGreaterThanOrEqual(1);
      expect(fs.readdirSync(storeDir)).toEqual([]);
      // The persisted run row went away with the stop.
      const servers = testingModule.get<Repository<RunServerEntity>>(
        getRepositoryToken(RunServerEntity),
      );
      await expect(servers.count()).resolves.toBe(0);
    });
  });

  describe('folders', () => {
    it('creates, lists, renames and deletes folders via REST', async () => {
      const created = await request(app.getHttpServer())
        .post('/folders')
        .send({ name: 'Action picks' })
        .expect(201);
      expect(created.body.name).toBe('Action picks');
      expect(created.body.jobCounts.total).toBe(0);
      expect(created.body.packagesRoot).toBe(path.resolve(storeDir));

      // Duplicate names are rejected.
      await request(app.getHttpServer())
        .post('/folders')
        .send({ name: 'Action picks' })
        .expect(400);

      const renamed = await request(app.getHttpServer())
        .patch(`/folders/${created.body.id}`)
        .send({ name: 'Favorites' })
        .expect(200);
      expect(renamed.body.name).toBe('Favorites');

      const list = await request(app.getHttpServer())
        .get('/folders')
        .expect(200);
      expect(Array.isArray(list.body)).toBe(true);
      expect(list.body.some((f: any) => f.name === 'Favorites')).toBe(true);

      const del = await request(app.getHttpServer())
        .delete(`/folders/${created.body.id}`)
        .expect(200);
      expect(del.body).toEqual({ deleted: true, unassigned: 0 });
    });

    it('scopes jobs: creations carry the folder, lists filter by it', async () => {
      const before = (
        await request(app.getHttpServer())
          .get('/game-imports?folderId=none')
          .expect(200)
      ).body.total;

      const folder = (
        await request(app.getHttpServer())
          .post('/folders')
          .send({ name: 'Scoped' })
          .expect(201)
      ).body;

      // Two jobs in the folder, one ungrouped. Distinct games: global
      // dedup means each URL maps to exactly one row, ever.
      const a = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(1), folderId: folder.id })
        .expect(201);
      await request(app.getHttpServer())
        .post('/game-imports/batch')
        .send({ sourceUrls: [gameUrl(2)], folderId: folder.id })
        .expect(201);
      const ungroupedJob = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(3) })
        .expect(201);
      await waitFor(a.body.id, ['completed', 'failed']);

      // The folder view counts only its own jobs.
      const view = await request(app.getHttpServer())
        .get(`/folders/${folder.id}`)
        .expect(200);
      expect(view.body.jobCounts.total).toBe(2);

      // Scoped listing returns only folder jobs.
      const scoped = await request(app.getHttpServer())
        .get(`/game-imports?folderId=${folder.id}`)
        .expect(200);
      expect(scoped.body.total).toBe(2);

      // "none" returns only ungrouped jobs (exactly one new one).
      const ungrouped = await request(app.getHttpServer())
        .get('/game-imports?folderId=none')
        .expect(200);
      expect(ungrouped.body.total).toBe(before + 1);
      expect(
        ungrouped.body.items.some((j: any) => j.id === ungroupedJob.body.id),
      ).toBe(true);
      expect(ungrouped.body.items.some((j: any) => j.id === a.body.id)).toBe(
        false,
      );

      // Unlisted scope returns everything (folder + ungrouped).
      const all = await request(app.getHttpServer())
        .get('/game-imports')
        .expect(200);
      expect(all.body.total).toBeGreaterThanOrEqual(3);

      // Unknown folder ids are rejected at creation.
      await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: base, folderId: randomUUID() })
        .expect(400);

      // Deleting the folder unassigns its jobs without deleting them.
      await request(app.getHttpServer())
        .delete(`/folders/${folder.id}`)
        .expect(200);
      const after = await request(app.getHttpServer())
        .get('/game-imports?folderId=none')
        .expect(200);
      expect(after.body.total).toBe(before + 3);
    });

    it('serves the home page and folder-scoped console pages', async () => {
      const home = await request(app.getHttpServer()).get('/').expect(200);
      expect(home.text).toContain('<!doctype html>');
      expect(home.text).toContain('id="foldersGrid"');

      const ungrouped = await request(app.getHttpServer())
        .get('/console/none')
        .expect(200);
      expect(ungrouped.text).toContain('var FOLDER_ID = "none"');

      const folder = (
        await request(app.getHttpServer())
          .post('/folders')
          .send({ name: 'UI folder' })
          .expect(201)
      ).body;
      const page = await request(app.getHttpServer())
        .get(`/console/${folder.id}`)
        .expect(200);
      expect(page.text).toContain(`var FOLDER_ID = "${folder.id}"`);

      // Legacy /console redirects to the ungrouped console.
      await request(app.getHttpServer()).get('/console').expect(302);
    });

    it('numbers jobs sequentially and supports status filter + sorting', async () => {
      // Create two distinct jobs; they get consecutive seq numbers.
      const a = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(4) })
        .expect(201);
      const b = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(5) })
        .expect(201);
      await waitFor(a.body.id, ['completed', 'failed']);
      await waitFor(b.body.id, ['completed', 'failed']);

      const got = await request(app.getHttpServer())
        .get(`/game-imports/${a.body.id}`)
        .expect(200);
      expect(Number.isInteger(got.body.seq)).toBe(true);

      // Seq ASC ordering: seqs on the page come back ascending.
      const asc = await request(app.getHttpServer())
        .get('/game-imports?sort=seq&dir=ASC&limit=200')
        .expect(200);
      const seqs = asc.body.items
        .map((j: any) => j.seq)
        .filter((n: any) => Number.isInteger(n));
      expect(seqs.length).toBeGreaterThan(1);
      expect(seqs).toEqual([...seqs].sort((x: any, y: any) => x - y));

      // Status filter returns only matching rows.
      const completed = await request(app.getHttpServer())
        .get('/game-imports?status=completed&limit=200')
        .expect(200);
      expect(completed.body.items.length).toBeGreaterThan(0);
      expect(
        completed.body.items.every((j: any) => j.status === 'completed'),
      ).toBe(true);

      // Invalid status values are ignored, not 500s.
      await request(app.getHttpServer())
        .get('/game-imports?status=bogus')
        .expect(200);
    });

    it('searches jobs by URL substring (q param)', async () => {
      // demo-4 was created earlier in this suite; search must find only it.
      const res = await request(app.getHttpServer())
        .get('/game-imports?q=demo-4&limit=200')
        .expect(200);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      expect(
        res.body.items.every((j: any) => j.sourceUrl.includes('demo-4')),
      ).toBe(true);

      // Search composes with the status filter.
      const scoped = await request(app.getHttpServer())
        .get('/game-imports?q=demo-4&status=completed&limit=200')
        .expect(200);
      expect(
        scoped.body.items.every(
          (j: any) =>
            j.sourceUrl.includes('demo-4') && j.status === 'completed',
        ),
      ).toBe(true);

      // Gibberish matches nothing instead of erroring.
      const empty = await request(app.getHttpServer())
        .get('/game-imports?q=no-such-game-anywhere-zzz')
        .expect(200);
      expect(empty.body.total).toBe(0);
      expect(empty.body.items).toEqual([]);
    });

    it('globally dedupes games across folders, reporting where they live', async () => {
      // First import lands in a folder.
      const folder = (
        await request(app.getHttpServer())
          .post('/folders')
          .send({ name: 'Dedup home' })
          .expect(201)
      ).body;
      const first = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(6), folderId: folder.id })
        .expect(201);
      expect(first.body.reused).toBe(false);
      await waitFor(first.body.id, ['completed', 'failed']);

      // Re-adding the same game to ANOTHER folder reuses the row and
      // reports the folder it actually lives in.
      const other = (
        await request(app.getHttpServer())
          .post('/folders')
          .send({ name: 'Other folder' })
          .expect(201)
      ).body;
      const again = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(6), folderId: other.id })
        .expect(201);
      expect(again.body.reused).toBe(true);
      expect(again.body.id).toBe(first.body.id);
      expect(again.body.existingFolderName).toBe('Dedup home');

      // Even a FAILED game is never duplicated…
      const failedGame = `https://partner.example/games/missing-${Date.now()}`;
      const f1 = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: failedGame })
        .expect(201);
      await waitFor(f1.body.id, ['failed']);
      const f2 = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: failedGame })
        .expect(201);
      expect(f2.body.id).toBe(f1.body.id);
      expect(f2.body.reused).toBe(true);
      // …and batches report duplicates with their folders.
      const batch = await request(app.getHttpServer())
        .post('/game-imports/batch')
        .send({ sourceUrls: [gameUrl(6), failedGame] })
        .expect(201);
      expect(batch.body.created).toBe(0);
      expect(batch.body.reused).toBe(2);
      expect(batch.body.duplicates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            jobId: first.body.id,
            folderName: 'Dedup home',
          }),
          expect.objectContaining({ jobId: f1.body.id, folderName: null }),
        ]),
      );
    });
  });

  describe('per-job delete + forced re-import', () => {
    async function waitGone(p: string, timeoutMs = 5000): Promise<void> {
      const start = Date.now();
      for (;;) {
        if (!fs.existsSync(p)) return;
        if (Date.now() - start > timeoutMs) {
          throw new Error(`Timed out waiting for ${p} to disappear`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    it('force starts a fresh run for an already-imported game', async () => {
      const first = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(7) })
        .expect(201);
      await waitFor(first.body.id, ['completed', 'failed']);

      const again = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(7) })
        .expect(201);
      expect(again.body.id).toBe(first.body.id);

      const forced = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(7), force: true })
        .expect(201);
      expect(forced.body.id).not.toBe(first.body.id);
      expect(forced.body.status).toBe('queued');
      await waitFor(forced.body.id, ['completed', 'failed']);
    });

    it('DELETE removes the row and its package from disk', async () => {
      const created = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(8) })
        .expect(201);
      const done = await waitFor(created.body.id, ['completed', 'failed']);
      expect(done.status).toBe('completed');
      const pkgRoot = done.packageUrl as string;
      expect(fs.existsSync(path.join(pkgRoot, 'index.html'))).toBe(true);

      const del = await request(app.getHttpServer())
        .delete(`/game-imports/${created.body.id}`)
        .expect(200);
      expect(del.body.deleted).toBe(true);
      expect(del.body.clearedPackage).toBe(true);
      // The package directory is really gone from disk.
      expect(fs.existsSync(pkgRoot)).toBe(false);
      // And the row is gone.
      await request(app.getHttpServer())
        .get(`/game-imports/${created.body.id}`)
        .expect(404);
    });

    it('rejects DELETE for unknown jobs', async () => {
      await request(app.getHttpServer())
        .delete(`/game-imports/${randomUUID()}`)
        .expect(404);
    });

    it('the worker drops the temp work dir when a job finishes', async () => {
      const created = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(9) })
        .expect(201);
      await waitFor(created.body.id, ['completed', 'failed']);
      // Cleanup runs right after the terminal write; allow it to land.
      await waitGone(path.join(workDir, created.body.id));
    });
  });

  describe('retry-failed, storage sizes and export', () => {
    it('retries failed games in place without adding rows', async () => {
      const folder = (
        await request(app.getHttpServer())
          .post('/folders')
          .send({ name: 'Retry box' })
          .expect(201)
      ).body;
      // Seed a failed row directly (deterministic, no download involved).
      const failed = jobs.create({
        id: randomUUID(),
        sourceUrl: base,
        status: 'failed',
        progress: 0,
        detectedEngine: null,
        downloadedFiles: 0,
        totalFiles: 0,
        currentStep: 'failed',
        error: 'boom',
        packageUrl: null,
        folderId: folder.id,
        logs: [],
      });
      await jobs.save(failed);
      const before = await jobs.count();

      const res = await request(app.getHttpServer())
        .post('/game-imports/retry-failed')
        .send({ folderId: folder.id })
        .expect(200);
      expect(res.body.retried).toBe(1);
      // Same row, back to queued — totals never inflate.
      expect(res.body.jobs[0].id).toBe(failed.id);
      expect(res.body.jobs[0].status).toBe('queued');
      expect(await jobs.count()).toBe(before);

      // Explicit ids: a fresh failed seed retries; unknown ids report
      // not-found. (Seeds are inserted directly, never enqueued, so no
      // background worker can touch them first.)
      const seed = jobs.create({
        id: randomUUID(),
        sourceUrl: base,
        status: 'failed',
        progress: 0,
        detectedEngine: null,
        downloadedFiles: 0,
        totalFiles: 0,
        currentStep: 'failed',
        error: 'boom',
        packageUrl: null,
        folderId: folder.id,
        logs: [],
      });
      await jobs.save(seed);
      const missing = randomUUID();
      const again = await request(app.getHttpServer())
        .post('/game-imports/retry')
        .send({ jobIds: [seed.id, missing] })
        .expect(200);
      expect(again.body.retried).toBe(1);
      expect(again.body.jobs[0].id).toBe(seed.id);
      expect(again.body.skipped).toEqual([
        { id: missing, reason: 'not-found' },
      ]);
      expect(await jobs.count()).toBe(before + 1);
    });

    it('returns zero when a folder has no failed games', async () => {
      const folder = (
        await request(app.getHttpServer())
          .post('/folders')
          .send({ name: 'Clean folder' })
          .expect(201)
      ).body;
      const res = await request(app.getHttpServer())
        .post('/game-imports/retry-failed')
        .send({ folderId: folder.id })
        .expect(200);
      expect(res.body).toEqual({ retried: 0, jobs: [] });
    });

    it('reports per-folder disk usage with ?storage=true', async () => {
      const folder = (
        await request(app.getHttpServer())
          .post('/folders')
          .send({ name: 'Sized' })
          .expect(201)
      ).body;
      const created = await request(app.getHttpServer())
        .post('/game-imports')
        .send({ sourceUrl: gameUrl(10), folderId: folder.id })
        .expect(201);
      const done = await waitFor(created.body.id, ['completed', 'failed']);
      expect(done.status).toBe('completed');

      const res = await request(app.getHttpServer())
        .get('/folders?storage=true')
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      for (const f of res.body) {
        expect(f.storage).toBeDefined();
        expect(typeof f.storage.bytes).toBe('number');
        expect(typeof f.storage.packages).toBe('number');
      }
      const sized = res.body.find((f: any) => f.id === folder.id);
      expect(sized.storage.packages).toBe(1);
      expect(sized.storage.bytes).toBeGreaterThan(0);

      // Plain listing stays light (no storage key at all).
      const plain = await request(app.getHttpServer())
        .get('/folders')
        .expect(200);
      expect(plain.body.every((f: any) => f.storage === undefined)).toBe(true);
    });

    it('exports the whole library as a downloadable JSON backup', async () => {
      const res = await request(app.getHttpServer())
        .get('/folders/export')
        .expect(200);
      expect(res.headers['content-disposition']).toMatch(
        /game-folders-backup-/,
      );
      expect(res.body.exportedAt).toBeTruthy();
      expect(Array.isArray(res.body.folders)).toBe(true);
      const sized = res.body.folders.find((f: any) => f.name === 'Sized');
      expect(sized).toBeDefined();
      expect(sized.games.some((g: any) => g.sourceUrl === gameUrl(10))).toBe(
        true,
      );
    });

    it('imports a backup file, creating folders and skipping existing games', async () => {
      const first = await request(app.getHttpServer())
        .post('/folders/import')
        .send({
          exportedAt: new Date().toISOString(),
          folders: [
            {
              name: 'Restored',
              games: [
                { sourceUrl: gameUrl(10) },
                { sourceUrl: base },
                { sourceUrl: 'https://partner.example/games/demo-99' },
              ],
            },
            { name: 'Ungrouped', games: [] },
          ],
        })
        .expect(200);
      // gameUrl(10) + base already exist (skipped); demo-99 is new.
      expect(first.body.gamesCreated).toBe(1);
      expect(first.body.gamesSkipped).toBe(2);
      expect(first.body.foldersCreated).toBe(1);

      // Re-importing the same file only reuses; games stay skipped.
      const second = await request(app.getHttpServer())
        .post('/folders/import')
        .send({
          folders: [
            {
              name: 'Restored',
              games: [
                { sourceUrl: gameUrl(10) },
                { sourceUrl: base },
                { sourceUrl: 'https://partner.example/games/demo-99' },
              ],
            },
          ],
        })
        .expect(200);
      expect(second.body).toEqual({
        foldersCreated: 0,
        foldersReused: 1,
        gamesCreated: 0,
        gamesSkipped: 3,
      });

      // …and rejects garbage instead of 500-ing.
      await request(app.getHttpServer())
        .post('/folders/import')
        .send({ folders: 'nope' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/folders/import')
        .send({ folders: [{ name: 'X', games: [{ sourceUrl: 'x' }] }] })
        .expect(400);
    });
  });
});
