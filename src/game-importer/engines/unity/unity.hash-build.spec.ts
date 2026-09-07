import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { defaultImportLimits } from '../../core/types';
import { DiagnosticCode, ImportError } from '../../core/diagnostics';
import { SourcePolicyService } from '../../core/source-policy';
import { SecureDownloader } from '../../core/downloader';
import { contentTypeForFile } from '../../core/path-utils';
import { GamePackage } from '../../core/types';
import { UnityDetector } from './unity.detector';
import { UnityLoaderParser } from './unity.loader-parser';
import { UnityAssetResolver } from './unity.asset-resolver';
import { UnityConfigDiscovery } from './unity.config-discovery';
import { UnityDecompressor } from './unity.decompressor';
import { UnityValidator } from './unity.validator';
import { UnityImporter } from './unity.importer';

/**
 * Content-hashed Unity builds: the delivery layer names files by content
 * hash (`962b….js` instead of `game.loader.js`) and describes their roles
 * in a machine-readable manifest (`unityLoaderUrl` + `unityConfigOptions`).
 * All fixtures below use Unity's own vocabulary with fictional hosts —
 * no platform concepts leak into the engine layer.
 */
const HASH_SHELL = `<html><head><title>Hash Racer Files</title></head><body>
<div id="ziggyLoader"></div>
<script>var options = {"loader":"unity2020","loaderOptions":{"showProgress":true,
"unityLoaderUrl":"https://cdn.example/hash-racer/19/Build/962b15be668bc5114f6e2305562e0c45.js",
"unityConfigOptions":{
"codeUrl":"https://cdn.example/hash-racer/19/Build/2d3f9aae09c457a393fcd4d8d6b51b47.wasm.br",
"dataUrl":"https://cdn.example/hash-racer/19/Build/ef2e912040977f97dcf162924204fefc.data.br",
"frameworkUrl":"https://cdn.example/hash-racer/19/Build/ba07d2a961712b9f77f680983eefa021.js.br"}}},
"gameName":"Hash Racer"};</script>
<script>var SDK_READY = false;</script>
</body></html>`;

const HASH_NAMES = [
  '962b15be668bc5114f6e2305562e0c45.js',
  '2d3f9aae09c457a393fcd4d8d6b51b47.wasm.br',
  'ef2e912040977f97dcf162924204fefc.data.br',
  'ba07d2a961712b9f77f680983eefa021.js.br',
];

const HASH_ROLES = {
  loaderUrl:
    'https://cdn.example/hash-racer/19/Build/962b15be668bc5114f6e2305562e0c45.js',
  dataUrl:
    'https://cdn.example/hash-racer/19/Build/ef2e912040977f97dcf162924204fefc.data.br',
  frameworkUrl:
    'https://cdn.example/hash-racer/19/Build/ba07d2a961712b9f77f680983eefa021.js.br',
  codeUrl:
    'https://cdn.example/hash-racer/19/Build/2d3f9aae09c457a393fcd4d8d6b51b47.wasm.br',
};

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.SOURCE_ALLOWED_HOSTS = 'cdn.example';
  process.env.ALLOW_ANY_HTTPS = 'false';
  process.env.UNITY_STREAMING_ASSETS_RUNTIME_DISCOVERY = 'false';
  process.env.UNITY_STREAMING_ASSETS_LOCAL_DISCOVERY = 'false';
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

function buildDiscovery(): UnityConfigDiscovery {
  return new UnityConfigDiscovery(
    new UnityLoaderParser(),
    new SourcePolicyService(),
  );
}

describe('unity hashed-build detection', () => {
  it('recognizes an explicit delivery manifest with hashed filenames', async () => {
    const res = await new UnityDetector().detect({
      sourceUrl: 'https://cdn.example/hash-racer',
      finalUrl: 'https://cdn.example/hash-racer/index.html',
      html: HASH_SHELL,
      fileNames: HASH_NAMES,
    });
    expect(res.engine).toBe('unity');
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);
    const codes = res.signals.filter((s) => s.matched).map((s) => s.name);
    expect(codes).toContain('unity-delivery-manifest');
    expect(codes).toContain('hashed-unity-build');
  });

  it('does not floor confidence on a bare config triple without delivery keys', async () => {
    const res = await new UnityDetector().detect({
      sourceUrl: 'https://cdn.example/plain',
      finalUrl: 'https://cdn.example/plain/index.html',
      html: '<html><body><script>var c={dataUrl:"g.data",frameworkUrl:"g.framework.js",codeUrl:"g.wasm"};</script></body></html>',
      fileNames: ['app.js'],
    });
    // Only the triple fires: additive scoring, no conclusive manifest.
    expect(res.confidence).toBeLessThan(0.5);
  });

  it('ignores non-Unity pages as before', async () => {
    const res = await new UnityDetector().detect({
      sourceUrl: 'https://cdn.example/blog',
      finalUrl: 'https://cdn.example/blog/index.html',
      html: '<html><body><h1>hello</h1><script src="app.js"></script></body></html>',
      fileNames: ['app.js'],
    });
    expect(res.confidence).toBeLessThan(0.5);
  });
});

describe('unity hashed-build config discovery from roles', () => {
  const LOADER_URL = HASH_ROLES.loaderUrl;
  const ENTRY_URL = 'https://cdn.example/hash-racer/index.html';
  const noFetch = async (): Promise<string> => {
    throw new Error('external fetch must not happen');
  };

  it('builds config from role-labeled URLs without extension guessing', async () => {
    const d = await buildDiscovery().discover({
      loaderJs: '/* generic hashed loader: reads external config */',
      loaderUrl: LOADER_URL,
      entryHtml: '<html></html>',
      entryUrl: ENTRY_URL,
      adapterAssetUrls: [],
      adapterBuild: { ...HASH_ROLES },
      fetchExternalScript: noFetch,
    });
    expect(d.source).toBe('adapter-hints');
    expect(d.build.dataUrl).toBe(HASH_ROLES.dataUrl);
    expect(d.build.frameworkUrl).toBe(HASH_ROLES.frameworkUrl);
    expect(d.build.codeUrl).toBe(HASH_ROLES.codeUrl);
    const codes = d.diagnostics.map((x) => x.code);
    expect(codes).toContain(DiagnosticCode.UNITY_CONFIG_FROM_ADAPTER_HINTS);
  });

  it('explicit page literals win over roles', async () => {
    const d = await buildDiscovery().discover({
      loaderJs: 'var cfg={dataUrl:"Build/local.data"};',
      loaderUrl: LOADER_URL,
      entryHtml: '<html></html>',
      entryUrl: ENTRY_URL,
      adapterAssetUrls: [],
      adapterBuild: { ...HASH_ROLES },
      fetchExternalScript: noFetch,
    });
    expect(d.build.dataUrl).toBe('Build/local.data');
    expect(d.build.frameworkUrl).toBe(HASH_ROLES.frameworkUrl);
  });

  it('refuses non-http role values and fails closed when unusable', async () => {
    let caught: unknown;
    try {
      await buildDiscovery().discover({
        loaderJs: '/* generic */',
        loaderUrl: LOADER_URL,
        entryHtml: '<html></html>',
        entryUrl: ENTRY_URL,
        adapterAssetUrls: [],
        adapterBuild: {
          frameworkUrl: 'ftp://cdn.example/evil.js',
          codeUrl: 'javascript:alert(1)',
        },
        fetchExternalScript: noFetch,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).code).toBe(
      DiagnosticCode.UNITY_CONFIG_NOT_FOUND,
    );
  });

  it('keeps relative role values raw for base resolution', async () => {
    const d = await buildDiscovery().discover({
      loaderJs: '/* generic */',
      loaderUrl: LOADER_URL,
      entryHtml: '<html></html>',
      entryUrl: ENTRY_URL,
      adapterAssetUrls: [],
      adapterBuild: {
        dataUrl: 'https://cdn.example/b/ef.data.br',
        streamingAssetsUrl: 'StreamingAssets',
      },
      fetchExternalScript: noFetch,
    });
    expect(d.build.dataUrl).toBe('https://cdn.example/b/ef.data.br');
    expect(d.build.streamingAssetsUrl).toBe('StreamingAssets');
  });
});

describe('unity hashed-build package validation', () => {
  function writePackage(files: Record<string, string>): GamePackage {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-val-'));
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
    return {
      manifest: {
        name: 'hash',
        engine: 'unity',
        entryFile: 'index.html',
        createdAt: new Date().toISOString(),
        sourceUrl: 'https://cdn.example/hash-racer',
        fileCount: list.length,
        totalBytes: list.reduce((a, f) => a + f.bytes, 0),
        assets: list.map((f) => ({ path: f.path, bytes: f.bytes })),
      },
      rootPath: dir,
      files: list,
    };
  }

  it('accepts hash-named loaders referenced by the entry', async () => {
    const pkg = writePackage({
      'index.html':
        '<html><body><canvas></canvas><script src="Build/962b15be668bc5114f6e2305562e0c45.js"></script></body></html>',
      'Build/962b15be668bc5114f6e2305562e0c45.js': 'loader js',
      'Build/2d3f9aae09c457a393fcd4d8d6b51b47.wasm': 'wasm',
      'Build/ef2e912040977f97dcf162924204fefc.data': 'data',
    });
    const res = await new UnityValidator().validateDetailed(pkg);
    expect(res.valid).toBe(true);
  });

  it('still rejects a missing loader', async () => {
    const pkg = writePackage({
      'index.html': '<html><body><canvas></canvas></body></html>',
      'Build/2d.wasm': 'wasm',
      'Build/ef.data': 'data',
    });
    const res = await new UnityValidator().validateDetailed(pkg);
    expect(res.valid).toBe(false);
    expect(res.errors.join(' ')).toMatch(/loader/);
  });
});

describe('unity hashed-build importer end to end', () => {
  const ENTRY_URL = 'https://cdn.example/hash-racer/index.html';
  const ROLE = HASH_ROLES;
  const FRAMEWORK_SRC = 'framework js with Module.streamingAssetsUrl read';
  const DATA_SRC = 'UnityWebData payload';
  const WASM_SRC = 'wasm bytes \u0000asm plus padding';
  // Loader carries EMBEDDED absolute remote literals (hash-build shape):
  // the importer must localize them to packaged paths.
  const LOADER_SRC =
    'var unityConfig={dataUrl:"' +
    ROLE.dataUrl +
    '",frameworkUrl:"' +
    ROLE.frameworkUrl +
    '",codeUrl:"' +
    ROLE.codeUrl +
    '"};function createUnityInstance(c,config){return Promise.resolve(config);}';

  function fakeDownloader(): SecureDownloader {
    const br = (s: string): Buffer =>
      zlib.brotliCompressSync(Buffer.from(s)) as Buffer;
    const map: Record<string, Buffer> = {
      [ENTRY_URL]: Buffer.from(HASH_SHELL),
      [ROLE.loaderUrl]: Buffer.from(LOADER_SRC),
      [ROLE.frameworkUrl]: br(FRAMEWORK_SRC),
      [ROLE.dataUrl]: br(DATA_SRC),
      [ROLE.codeUrl]: br(WASM_SRC),
    };
    return {
      fetchBuffer: async (url: string) => {
        const body = map[url];
        if (!body) throw new Error(`Fake 404 for ${url}`);
        return { finalUrl: url, status: 200, body, redirected: false };
      },
    } as unknown as SecureDownloader;
  }

  it('imports hashed builds via role labels with localized loader', async () => {
    const downloader = fakeDownloader();
    const policy = new SourcePolicyService();
    const parser = new UnityLoaderParser();
    const importer = new UnityImporter(
      new UnityDetector(),
      downloader,
      parser,
      new UnityAssetResolver(),
      new UnityDecompressor(),
      new UnityConfigDiscovery(parser, policy),
      policy,
    );
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-pkg-'));
    const collected: string[] = [];
    const pkg = await importer.import({
      jobId: 'hash-test',
      sourceUrl: ENTRY_URL,
      workDir,
      limits: defaultImportLimits(),
      resolvedSource: {
        source: 'test',
        canonicalUrl: ENTRY_URL,
        entryUrl: ENTRY_URL,
        assetUrls: [
          ROLE.loaderUrl,
          ROLE.dataUrl,
          ROLE.frameworkUrl,
          ROLE.codeUrl,
        ],
        unityBuild: {
          ...ROLE,
          streamingAssetsUrl:
            'https://cdn.example/hash-racer/19/StreamingAssets',
        },
      },
      collectDiagnostics: (d) => {
        collected.push(d.code);
      },
    });
    const paths = pkg.files.map((f) => f.path);
    expect(paths).toContain('Build/962b15be668bc5114f6e2305562e0c45.js');
    expect(paths).toContain('Build/ba07d2a961712b9f77f680983eefa021.js');
    expect(paths).toContain('Build/ef2e912040977f97dcf162924204fefc.data');
    expect(paths).toContain('Build/2d3f9aae09c457a393fcd4d8d6b51b47.wasm');
    // Brotli transport decoded into plain packaged artifacts.
    expect(paths).not.toContainEqual(expect.stringMatching(/\.br$/));
    // Packaged loader no longer points at remote absolute URLs.
    const packagedLoader = fs.readFileSync(
      path.join(pkg.rootPath, 'Build/962b15be668bc5114f6e2305562e0c45.js'),
      'utf8',
    );
    expect(packagedLoader).toContain(
      'Build/ef2e912040977f97dcf162924204fefc.data',
    );
    expect(packagedLoader).not.toContain('https://cdn.example/');
    // Manifest coherence + discovery evidence.
    expect(pkg.manifest.fileCount).toBe(pkg.files.length);
    expect(pkg.manifest.totalBytes).toBe(
      pkg.files.reduce((a, f) => a + f.bytes, 0),
    );
    expect(collected).toContain(DiagnosticCode.UNITY_LOADER_FOUND);
    expect(collected).toContain(DiagnosticCode.UNITY_CONFIG_FROM_ADAPTER_HINTS);
  });
});
