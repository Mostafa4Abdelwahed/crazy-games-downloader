import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SecureDownloader } from '../core/downloader';
import { SourcePolicyService } from '../core/source-policy';
import { PackageValidator } from '../core/validator';
import { defaultImportLimits, ImportContext } from '../core/types';
import { GenericHtml5Importer } from './generic-html5.importer';

const sha1 = (u: string): string =>
  crypto.createHash('sha1').update(u).digest('hex');

interface FakeEntry {
  body: Buffer;
  finalUrl?: string;
  contentType?: string;
}

function fakeDownloader(map: Record<string, FakeEntry>) {
  const calls: string[] = [];
  const headerCalls: Array<{ url: string; headers?: Record<string, string> }> =
    [];
  return {
    calls,
    headerCalls,
    fetchBuffer: async (
      url: string,
      opts?: { headers?: Record<string, string> },
    ) => {
      calls.push(url);
      headerCalls.push({ url, headers: opts?.headers });
      const hit = map[url];
      if (!hit) throw new Error(`Fake 404 for ${url}`);
      return {
        finalUrl: hit.finalUrl ?? url,
        status: 200,
        contentType: hit.contentType ?? 'application/octet-stream',
        body: hit.body,
        redirected: Boolean(hit.finalUrl && hit.finalUrl !== url),
      };
    },
  };
}

const OLD_HOSTS = process.env.SOURCE_ALLOWED_HOSTS;
const OLD_ANY = process.env.ALLOW_ANY_HTTPS;

function withPolicy(
  fn: () => Promise<void>,
  hosts = 'game-files.crazygames.com',
): Promise<void> {
  process.env.SOURCE_ALLOWED_HOSTS = hosts;
  process.env.ALLOW_ANY_HTTPS = 'false';
  return fn();
}

afterEach(() => {
  if (OLD_HOSTS === undefined) delete process.env.SOURCE_ALLOWED_HOSTS;
  else process.env.SOURCE_ALLOWED_HOSTS = OLD_HOSTS;
  if (OLD_ANY === undefined) delete process.env.ALLOW_ANY_HTTPS;
  else process.env.ALLOW_ANY_HTTPS = OLD_ANY;
});

const makeContext = (sourceUrl: string, workDir: string): ImportContext => ({
  jobId: 'job-1',
  sourceUrl,
  workDir,
  limits: defaultImportLimits(),
});

describe('GenericHtml5Importer detection', () => {
  const importer = new GenericHtml5Importer(
    {} as SecureDownloader,
    new SourcePolicyService(),
  );

  it('detects explicit html5 loader delivery with high confidence', async () => {
    const frame =
      '<script>var options = {"loader":"html5",' +
      '"loaderOptions":{"url":"https://c.game-files.crazygames.com/c/1/index.html"}};' +
      "loadScript('https://builds.crazygames.com/gameframe/v1/bundle.js'," +
      'function(){Crazygames.load(options);});</script>';
    const res = await importer.detect({ sourceUrl: 'x', html: frame });
    expect(res.engine).toBe('generic-html5');
    expect(res.confidence).toBeGreaterThanOrEqual(0.6);
    expect(
      res.signals.find((s) => s.name === 'loader-html5-name')?.matched,
    ).toBe(true);
  });

  it('stays low-confidence on Unity loader shells', async () => {
    const frame =
      '<script>var options = {"loader":"unity6","loaderOptions":{' +
      '"showProgress":true,"unityLoaderUrl":"https://files.crazygames.com/x/Build/fp.loader.js",' +
      '"unityConfigOptions":{"codeUrl":"https://files.crazygames.com/x/Build/fp.wasm","dataUrl":"https://files.crazygames.com/x/Build/fp.data","frameworkUrl":"https://files.crazygames.com/x/Build/fp.framework.js"}}};' +
      "loadScript('https://builds.crazygames.com/gameframe/v1/bundle.js'," +
      'function(){Bootstrapper.load(options);});</script>';
    const res = await importer.detect({
      sourceUrl: 'x',
      html: frame,
      portalHtml: '<html><body></body></html>',
    });
    expect(res.engine).toBe('generic-html5');
    expect(res.confidence).toBeLessThan(0.5);
  });

  it('stays below threshold for plain script pages', async () => {
    const res = await importer.detect({
      sourceUrl: 'x',
      html: '<html><body><script src="app.js"></script></body></html>',
    });
    expect(res.confidence).toBeLessThan(0.5);
  });
});

describe('GenericHtml5Importer import', () => {
  const entryUrl = 'https://c.game-files.crazygames.com/c/1/index.html';
  const jsUrl = 'https://c.game-files.crazygames.com/c/1/js/app.js';
  const cssUrl = 'https://c.game-files.crazygames.com/c/1/css/style.css';
  const pngUrl = 'https://c.game-files.crazygames.com/c/1/img/logo.png';
  const fontUrl = 'https://c.game-files.crazygames.com/c/1/fonts/a.woff2';

  const entryHtml = `<!doctype html>
<html><head>
<meta charset="utf-8">
<link rel="stylesheet" href="css/style.css">
</head><body>
<div id="game"></div>
<img src="img/logo.png" alt="logo">
<script src="js/app.js"></script>
<script>window.game.start();</script>
</body></html>`;

  const cssText = `.bg { background-image: url(../fonts/a.woff2); }`;

  function buildFakeDownloader(redirectFrom?: string) {
    const map: Record<string, FakeEntry> = {
      [entryUrl]: {
        body: Buffer.from(entryHtml),
        contentType: 'text/html',
      },
      [jsUrl]: {
        body: Buffer.from('var app = 1;'),
        contentType: 'text/javascript',
      },
      [cssUrl]: { body: Buffer.from(cssText), contentType: 'text/css' },
      [pngUrl]: { body: Buffer.from('png'), contentType: 'image/png' },
      [fontUrl]: {
        body: Buffer.from('font'),
        contentType: 'font/woff2',
      },
    };
    if (redirectFrom) {
      map[redirectFrom] = {
        body: Buffer.from(entryHtml),
        finalUrl: entryUrl,
        contentType: 'text/html',
      };
    }
    return fakeDownloader(map);
  }

  async function workDirFor(): Promise<string> {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'generic-html5-'));
  }

  it('downloads, localizes and packages an html5 game', async () => {
    await withPolicy(async () => {
      const workDir = await workDirFor();
      const downloader = buildFakeDownloader(
        'https://www.crazygames.com/game/crazy-chameleon',
      );
      const importer = new GenericHtml5Importer(
        downloader as unknown as SecureDownloader,
        new SourcePolicyService(),
      );
      const pkg = await importer.import(
        makeContext('https://www.crazygames.com/game/crazy-chameleon', workDir),
      );

      // Entry fetched first (context.sourceUrl fallback).
      expect(downloader.calls[0]).toBe(
        'https://www.crazygames.com/game/crazy-chameleon',
      );
      // Every download must carry the source page Referer (CDN hotlink
      // protection on game-files.crazygames.com rejects bare requests).
      for (const call of downloader.headerCalls) {
        expect(call.headers).toEqual({
          Referer: 'https://www.crazygames.com/game/crazy-chameleon',
        });
      }
      const pkgFiles = listFiles(pkg.rootPath);
      const assetNames = pkgFiles
        .filter((p) => p.startsWith('assets/'))
        .map((p) => path.posix.basename(p))
        .sort();

      // js + css + png are downloaded; the font arrives via the CSS pass.
      expect(assetNames).toEqual(
        [
          `${sha1(jsUrl)}.js`,
          `${sha1(cssUrl)}.css`,
          `${sha1(pngUrl)}.png`,
          `${sha1(fontUrl)}.woff2`,
        ].sort(),
      );

      const indexPath = path.join(pkg.rootPath, 'index.html');
      const indexHtml = fs.readFileSync(indexPath, 'utf8');
      expect(indexHtml).toContain(`assets/${sha1(jsUrl)}.js`);
      expect(indexHtml).not.toContain(jsUrl);
      expect(indexHtml).toContain('src="crazygames-sdk-stub.js"');

      const cssPath = path.join(pkg.rootPath, 'assets', `${sha1(cssUrl)}.css`);
      expect(fs.readFileSync(cssPath, 'utf8')).toContain(
        `assets/${sha1(fontUrl)}.woff2`,
      );

      const manifest = JSON.parse(
        fs.readFileSync(path.join(pkg.rootPath, 'manifest.json'), 'utf8'),
      );
      expect(manifest.engine).toBe('generic-html5');
      expect(manifest.entryFile).toBe('index.html');
      expect(manifest.fileCount).toBe(pkgFiles.length);
      // Validator invariant: totalBytes equals the sum of the packaged
      // file inventory (the manifest files entry is authoritative).
      expect(manifest.totalBytes).toBe(
        pkg.files.reduce((a, f) => a + f.bytes, 0),
      );

      // Package must pass the generic validator end-to-end.
      const validation = await new PackageValidator().validate(pkg);
      expect(validation.valid).toBe(true);
    });
  });

  it('prefers gameEntryUrl over the bootstrap frame URL', async () => {
    await withPolicy(async () => {
      const workDir = await workDirFor();
      const downloader = buildFakeDownloader();
      const importer = new GenericHtml5Importer(
        downloader as unknown as SecureDownloader,
        new SourcePolicyService(),
      );
      await importer.import({
        ...makeContext(
          'https://www.crazygames.com/game/crazy-chameleon',
          workDir,
        ),
        resolvedSource: {
          source: 'crazygames',
          canonicalUrl: 'https://www.crazygames.com/game/crazy-chameleon',
          entryUrl: 'https://c.game-files.crazygames.com/c/1/frame.html',
          gameEntryUrl: entryUrl,
          assetUrls: [],
          metadata: { title: 'Crazy Chameleon' },
        },
        collectDiagnostics: jest.fn(),
      });
      expect(downloader.calls[0]).toBe(entryUrl);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(workDir, 'package', 'manifest.json'), 'utf8'),
      );
      expect(manifest.name).toBe('Crazy Chameleon');
    });
  });

  it('produces a valid package when the page has no assets', async () => {
    await withPolicy(async () => {
      const workDir = await workDirFor();
      const downloader = fakeDownloader({
        [entryUrl]: {
          body: Buffer.from('<html><body><div id="game"></div></body></html>'),
          contentType: 'text/html',
        },
      });
      const importer = new GenericHtml5Importer(
        downloader as unknown as SecureDownloader,
        new SourcePolicyService(),
      );
      const pkg = await importer.import(makeContext(entryUrl, workDir));
      const validation = await new PackageValidator().validate(pkg);
      expect(validation.valid).toBe(true);
      expect(pkg.manifest.fileCount).toBe(3); // index + stub + manifest
    });
  });
});

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, relPath);
      else out.push(relPath);
    }
  };
  walk(root, '');
  return out;
}
