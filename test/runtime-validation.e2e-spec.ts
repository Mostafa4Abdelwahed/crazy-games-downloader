import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GameImporterModule } from '../src/game-importer/game-importer.module';
import { ImportJobEntity } from '../src/game-importer/entities/import-job.entity';
import { SecureDownloader } from '../src/game-importer/core/downloader';
import { PackageValidator } from '../src/game-importer/core/validator';
import { UnityValidator } from '../src/game-importer/engines/unity/unity.validator';
import { GamePackage } from '../src/game-importer/core/types';
import { contentTypeForFile } from '../src/game-importer/core/path-utils';
import { LocalPackageServer } from '../src/game-importer/runtime/local-package-server';
import { PlaywrightRuntimeValidator } from '../src/game-importer/runtime/playwright-runtime-validator';

const CRAZY_FIXTURES = path.join(
  __dirname,
  '..',
  'src',
  'game-importer',
  'sources',
  'crazygames',
  'fixtures',
);
const readFixture = (name: string): Buffer =>
  fs.readFileSync(path.join(CRAZY_FIXTURES, name));

const GAME = 'https://games.crazygames.com';

/**
 * Executable fixture loader stub. Carries the Unity build config as static
 * text (parsed by UnityLoaderParser without executing anything) and behaves
 * like a real Unity loader bundle at runtime: it defines
 * `createUnityInstance` and dynamically loads the framework script.
 */
const FIXTURE_LOADER_JS = `var FixtureBuildConfig = {
  dataUrl: "space-adventure.data",
  frameworkUrl: "space-adventure.framework.js",
  codeUrl: "space-adventure.wasm"
};
window.createUnityInstance = function (canvas, config) {
  config = config || FixtureBuildConfig;
  return new Promise(function (resolve, reject) {
    var s = document.createElement("script");
    s.src = "Build/space-adventure.framework.js";
    s.onload = function () {
      try {
        if (window.FixtureUnity && typeof window.FixtureUnity.boot === "function") {
          window.FixtureUnity.boot(canvas, config).then(resolve, reject);
        } else {
          reject(new Error("fixture framework missing boot"));
        }
      } catch (e) { reject(e); }
    };
    s.onerror = function () { reject(new Error("fixture framework failed to load")); };
    document.body.appendChild(s);
  });
};
`;

/**
 * Executable fixture framework stub: fetches data+wasm bytes, paints the
 * canvas, and raises the standard init signals (flag + console message).
 */
const FIXTURE_FRAMEWORK_JS = `window.FixtureUnity = {
  boot: async function (canvas, config) {
    const asset = (p) => "Build/" + String(p).split("/").pop();
    const [dataRes, wasmRes] = await Promise.all([
      fetch(asset(config.dataUrl)),
      fetch(asset(config.codeUrl)),
    ]);
    if (!dataRes.ok) throw new Error("fixture data fetch failed: " + dataRes.status);
    if (!wasmRes.ok) throw new Error("fixture wasm fetch failed: " + wasmRes.status);
    await dataRes.arrayBuffer();
    await wasmRes.arrayBuffer();
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d");
    if (ctx) { ctx.fillStyle = "#224488"; ctx.fillRect(0, 0, 800, 600); }
    window.unityInitialized = true;
    console.log("Unity runtime initialized (fixture build)");
    return { canvas };
  },
};
`;

const siteMap: Record<string, Buffer> = {
  'https://www.crazygames.com/game/space-adventure':
    readFixture('unity-page.html'),
  [`${GAME}/en_US/space-adventure/index.html`]: readFixture('unity-frame.html'),
  [`${GAME}/en_US/space-adventure/Build/space-adventure.loader.js`]:
    Buffer.from(FIXTURE_LOADER_JS),
  [`${GAME}/en_US/space-adventure/Build/space-adventure.framework.js`]:
    Buffer.from(FIXTURE_FRAMEWORK_JS),
  [`${GAME}/en_US/space-adventure/Build/space-adventure.data`]: Buffer.from(
    'FIXTURE-DATA'.repeat(20),
  ),
  [`${GAME}/en_US/space-adventure/Build/space-adventure.wasm`]: Buffer.from(
    'FIXTURE-WASM'.repeat(20),
  ),
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

/** Materialize a synthetic package dir + metadata (no importer involved). */
function makeSyntheticPackage(files: Record<string, string>): {
  pkg: GamePackage;
  dir: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-pkg-'));
  const list: GamePackage['files'] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    list.push({
      path: rel,
      bytes: Buffer.byteLength(content),
      contentType: contentTypeForFile(rel),
    });
  }
  const totalBytes = list.reduce((a, f) => a + f.bytes, 0);
  return {
    dir,
    pkg: {
      manifest: {
        name: 'synthetic',
        engine: 'unity',
        entryFile: 'index.html',
        createdAt: new Date().toISOString(),
        sourceUrl: 'synthetic://test',
        fileCount: list.length,
        totalBytes,
      },
      rootPath: dir,
      files: list,
    },
  };
}

describe('Runtime validation end to end (M3)', () => {
  let app: INestApplication;
  let jobs: Repository<ImportJobEntity>;
  const runtime = new PlaywrightRuntimeValidator(new LocalPackageServer());

  beforeAll(async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-rt-'));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-rt-'));
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

  async function waitFor(id: string, want: string[], timeoutMs = 30000) {
    const start = Date.now();
    for (;;) {
      const e = await jobs.findOneOrFail({ where: { id } });
      if (want.includes(e.status)) return e;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for ${want}, now=${e.status}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  it('fixture source -> adapter -> unity import -> package -> local HTTP -> Playwright -> success', async () => {
    const created = await request(app.getHttpServer())
      .post('/game-imports')
      .send({ sourceUrl: 'https://www.crazygames.com/game/space-adventure' })
      .expect(201);
    const done = await waitFor(created.body.id, ['completed', 'failed']);
    expect(done.status).toBe('completed');

    // Structured diagnostics were collected along the way.
    const job = await request(app.getHttpServer())
      .get(`/game-imports/${created.body.id}`)
      .expect(200);
    expect(job.body.errorCode).toBeNull();
    const codes = (job.body.diagnostics ?? []).map(
      (d: { code: string }) => d.code,
    );
    expect(codes).toContain('UNITY_LOADER_FOUND');
    expect(codes).toContain('UNITY_BUILD_CONFIG_FOUND');
    expect(codes).toContain('ASSET_DOWNLOADED');

    // Manifest carries slug/version/source/assets (M3).
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(done.packageUrl as string, 'manifest.json'),
        'utf8',
      ),
    );
    expect(manifest.engine).toBe('unity');
    expect(typeof manifest.slug).toBe('string');
    expect(manifest.version).toBe('1');
    expect(manifest.source?.platform).toBe('crazygames');
    expect(Array.isArray(manifest.assets)).toBe(true);

    // Package validation (generic + Unity) on the stored package.
    const files: GamePackage['files'] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(abs, rel);
        else {
          files.push({
            path: rel,
            bytes: fs.statSync(abs).size,
            contentType: contentTypeForFile(rel),
          });
        }
      }
    };
    walk(done.packageUrl as string, '');
    const stored: GamePackage = {
      manifest: { ...manifest, fileCount: files.length },
      rootPath: done.packageUrl as string,
      files,
    };
    expect(await new PackageValidator().validate(stored)).toEqual({
      valid: true,
      errors: [],
    });
    const unityCheck = await new UnityValidator().validateDetailed(stored);
    expect(unityCheck.valid).toBe(true);

    // Runtime validation over local HTTP in headless Chromium.
    const result = await runtime.validate(stored, { timeoutMs: 20000 });
    expect(result.success).toBe(true);
    expect(result.code).toBe('RUNTIME_OK');
    expect(result.unityInitialized).toBe(true);
    expect(result.pageErrors).toEqual([]);
    expect(result.failedRequests).toEqual([]);
    expect(result.consoleErrors).toEqual([]);
    expect(result.signals.matchedSignals).toEqual(
      expect.arrayContaining(['canvas', 'wasm-loaded', 'framework-loaded']),
    );
    expect(result.durationMs).toBeGreaterThan(0);
  }, 120000);

  it('captures console errors without failing a healthy init', async () => {
    const { pkg } = makeSyntheticPackage({
      'index.html': `<html><body><canvas id="unity-canvas"></canvas><script>
window.unityInitialized = true;
console.error("non-fatal fixture warning");
console.log("Unity fixture initialized");
</script></body></html>`,
    });
    const result = await runtime.validate(pkg, { timeoutMs: 8000 });
    expect(result.success).toBe(true);
    expect(result.consoleErrors).toEqual(
      expect.arrayContaining(['non-fatal fixture warning']),
    );
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'RUNTIME_CONSOLE_ERROR',
    );
  }, 60000);

  it('fails with RUNTIME_ERROR on uncaught page errors', async () => {
    const { pkg } = makeSyntheticPackage({
      'index.html': `<html><body><canvas id="unity-canvas"></canvas><script>
throw new Error("fixture kaboom");
</script></body></html>`,
    });
    const result = await runtime.validate(pkg, { timeoutMs: 8000 });
    expect(result.success).toBe(false);
    expect(result.code).toBe('RUNTIME_ERROR');
    expect(result.pageErrors.join(' ')).toMatch(/kaboom/);
  }, 60000);

  it('fails required Unity assets with MISSING_ASSET diagnostics', async () => {
    const { pkg } = makeSyntheticPackage({
      // framework.js is referenced but NOT packaged -> local 404.
      'index.html': `<html><body><canvas id="unity-canvas"></canvas>
<script src="Build/game.framework.js"></script>
<script>window.unityInitialized = true; console.log("Unity fixture initialized");</script>
</body></html>`,
    });
    const result = await runtime.validate(pkg, { timeoutMs: 8000 });
    expect(result.success).toBe(false);
    expect(result.code).toBe('RUNTIME_ERROR');
    expect(result.failedRequests.map((r) => r.url).join(' ')).toMatch(
      /game\.framework\.js/,
    );
    expect(result.diagnostics.map((d) => d.code)).toContain('MISSING_ASSET');
  }, 60000);

  it('reports RUNTIME_TIMEOUT when Unity never initializes', async () => {
    const { pkg } = makeSyntheticPackage({
      'index.html': `<html><body><canvas id="unity-canvas"></canvas><p>loading…</p></body></html>`,
    });
    const started = Date.now();
    const result = await runtime.validate(pkg, { timeoutMs: 3000 });
    expect(result.success).toBe(false);
    expect(result.code).toBe('RUNTIME_TIMEOUT');
    expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
  }, 60000);

  it('records external references without bypassing them', async () => {
    const { pkg } = makeSyntheticPackage({
      // Unroutable loopback port: fails fast, no DNS, deterministic.
      'index.html': `<html><body><canvas id="unity-canvas"></canvas>
<script src="http://127.0.0.1:9/ext.js"></script>
<script>window.unityInitialized = true; console.log("Unity fixture initialized");</script>
</body></html>`,
    });
    const result = await runtime.validate(pkg, { timeoutMs: 8000 });
    expect(result.success).toBe(true);
    expect(result.externalRequests.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'EXTERNAL_REFERENCE',
    );
  }, 60000);
});
