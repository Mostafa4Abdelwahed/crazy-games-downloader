import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultImportLimits } from '../../core/types';
import { DiagnosticCode } from '../../core/diagnostics';
import { SourcePolicyService } from '../../core/source-policy';
import { SecureDownloader } from '../../core/downloader';
import { UnityDetector } from './unity.detector';
import { UnityLoaderParser } from './unity.loader-parser';
import { UnityAssetResolver } from './unity.asset-resolver';
import { UnityConfigDiscovery } from './unity.config-discovery';
import { UnityDecompressor } from './unity.decompressor';
import { UnityImporter } from './unity.importer';
import { UnityStreamingAssetsDiscovery } from './unity.streaming-assets-discovery';
import {
  extractStreamingAssetsRefs,
  findStreamingAssetsHint,
  isStreamingAssetsUrl,
  normalizeStreamingPrefix,
  streamingPrefixOfUrl,
  toRemoteStreamingAssetsUrl,
  toStreamingAssetsPackagePath,
} from './unity.streaming-assets';

const LOADER_BASE = 'https://cdn.example/games/racer/Build/g.loader.js';
const baseOf = (streamingAssetsUrl = 'StreamingAssets') => ({
  streamingAssetsUrl,
  configBaseUrl: LOADER_BASE,
});

const OLD_ENV = { ...process.env };

function allowOnly(hosts: string): void {
  process.env.SOURCE_ALLOWED_HOSTS = hosts;
  process.env.ALLOW_ANY_HTTPS = 'false';
}

beforeEach(() => {
  allowOnly('cdn.example');
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('unity.streaming-assets path handling (generic, no filenames)', () => {
  it('1: detects StreamingAssets requests under a relative prefix', () => {
    expect(
      isStreamingAssetsUrl(
        'https://cdn.example/games/racer/Build/StreamingAssets/Master.bank',
        baseOf(),
      ),
    ).toBe(true);
    expect(
      isStreamingAssetsUrl(
        'https://cdn.example/games/racer/Build/g.framework.js',
        baseOf(),
      ),
    ).toBe(false);
  });

  it('2: resolves relative StreamingAssets URLs to package paths', () => {
    expect(
      toStreamingAssetsPackagePath('StreamingAssets/Master.bank', baseOf()),
    ).toBe('StreamingAssets/Master.bank');
  });

  it('3: resolves absolute StreamingAssets URLs to package paths', () => {
    expect(
      toStreamingAssetsPackagePath(
        'https://cdn.example/games/racer/Build/StreamingAssets/Master.bank',
        baseOf(),
      ),
    ).toBe('StreamingAssets/Master.bank');
  });

  it('4: preserves nested directories instead of flattening', () => {
    expect(
      toStreamingAssetsPackagePath(
        'https://cdn.example/games/racer/Build/StreamingAssets/audio/music/Master.bank',
        baseOf(),
      ),
    ).toBe('StreamingAssets/audio/music/Master.bank');
  });

  it('5: decodes percent-encoded paths', () => {
    expect(
      toStreamingAssetsPackagePath(
        'https://cdn.example/games/racer/Build/StreamingAssets/my%20bank.bank',
        baseOf(),
      ),
    ).toBe('StreamingAssets/my bank.bank');
  });

  it('6: strips query strings and fragments', () => {
    expect(
      toStreamingAssetsPackagePath(
        'https://cdn.example/games/racer/Build/StreamingAssets/x.bank?v=123#frag',
        baseOf(),
      ),
    ).toBe('StreamingAssets/x.bank');
  });

  it('rejects traversal and bare-prefix requests', () => {
    expect(
      toStreamingAssetsPackagePath(
        'https://cdn.example/a/StreamingAssets/../evil.js',
        baseOf(),
      ),
    ).toBeNull();
    expect(
      toStreamingAssetsPackagePath(
        'https://cdn.example/a/StreamingAssets',
        baseOf(),
      ),
    ).toBeNull();
  });

  it('matches absolute streamingAssetsUrl bases (CDN split origins)', () => {
    const b = {
      streamingAssetsUrl: 'https://files.example/g/77/StreamingAssets',
      configBaseUrl: 'https://cdn.example/Build/g.loader.js',
    };
    expect(
      isStreamingAssetsUrl(
        'https://files.example/g/77/StreamingAssets/audio/x.bank',
        b,
      ),
    ).toBe(true);
    expect(
      toStreamingAssetsPackagePath(
        'https://files.example/g/77/StreamingAssets/audio/x.bank',
        b,
      ),
    ).toBe('StreamingAssets/audio/x.bank');
  });

  it('normalizes relative, dotted and nested prefixes; rejects junk', () => {
    expect(normalizeStreamingPrefix('StreamingAssets')).toBe('StreamingAssets');
    expect(normalizeStreamingPrefix('./StreamingAssets/')).toBe(
      'StreamingAssets',
    );
    expect(normalizeStreamingPrefix('webgl/StreamingAssets')).toBe(
      'webgl/StreamingAssets',
    );
    expect(
      normalizeStreamingPrefix('https://files.example/g/77/StreamingAssets'),
    ).toBe('g/77/StreamingAssets');
    expect(normalizeStreamingPrefix('')).toBeNull();
    expect(normalizeStreamingPrefix('Build')).toBeNull();
    expect(normalizeStreamingPrefix('../StreamingAssets')).toBeNull();
  });

  it('resolves package paths back to remote URLs for download', () => {
    expect(
      toRemoteStreamingAssetsUrl('StreamingAssets/audio/x.bank', {
        streamingAssetsUrl: 'StreamingAssets',
        configBaseUrl: LOADER_BASE,
      }),
    ).toBe(
      'https://cdn.example/games/racer/Build/StreamingAssets/audio/x.bank',
    );
  });

  it('statically extracts quoted StreamingAssets refs without execution', () => {
    const refs = extractStreamingAssetsRefs(
      'fetch("StreamingAssets/audio/Master.bank"); var s=\'StreamingAssets/x.json?v=1\'; var unrelated="Build/g.data";',
    );
    expect(refs).toContain('StreamingAssets/audio/Master.bank');
    expect(refs).toContain('StreamingAssets/x.json');
    expect(refs).not.toContain('Build/g.data');
  });

  it('derives the StreamingAssets directory URL from dir and file hints', () => {
    expect(
      streamingPrefixOfUrl('https://files.example/g/77/StreamingAssets'),
    ).toBe('https://files.example/g/77/StreamingAssets/');
    expect(
      streamingPrefixOfUrl(
        'https://files.example/g/77/StreamingAssets/audio/x.bank?v=1',
      ),
    ).toBe('https://files.example/g/77/StreamingAssets/');
    expect(
      streamingPrefixOfUrl('https://files.example/g/77/Build/g.data'),
    ).toBeNull();
    expect(streamingPrefixOfUrl('not a url')).toBeNull();
  });

  it('finds the prefix signal in adapter hints without filename assumptions', () => {
    expect(
      findStreamingAssetsHint([
        'https://cdn.example/Build/g.data',
        'https://files.example/g/77/StreamingAssets',
      ]),
    ).toBe('https://files.example/g/77/StreamingAssets/');
    expect(
      findStreamingAssetsHint(['https://cdn.example/Build/g.data']),
    ).toBeNull();
  });

  it('matches segment-scoped requests when no explicit signal exists', () => {
    const seg = { streamingAssetsUrl: '', configBaseUrl: LOADER_BASE };
    expect(
      isStreamingAssetsUrl(
        'https://other.example/any/StreamingAssets/x.bank',
        seg,
      ),
    ).toBe(true);
    expect(
      toStreamingAssetsPackagePath(
        'https://other.example/any/StreamingAssets/nested/x.bank',
        seg,
      ),
    ).toBe('StreamingAssets/nested/x.bank');
    expect(isStreamingAssetsUrl('https://other.example/any/g.data', seg)).toBe(
      false,
    );
  });
});

describe('unity.streaming-assets policy + bounds', () => {
  function discovery(): UnityStreamingAssetsDiscovery {
    return new UnityStreamingAssetsDiscovery(
      {} as SecureDownloader,
      new SourcePolicyService(),
    );
  }

  it('7+8: keeps allowlisted StreamingAssets URLs, drops trackers/ads/non-prefix', () => {
    const d = discovery();
    const { urls, limitReached } = d.resolveCandidates({
      observedUrls: [
        'https://cdn.example/games/racer/Build/StreamingAssets/a.bank',
        'https://cdn.example/games/racer/Build/g.data',
        'https://tracker.example/StreamingAssets/evil.bank',
        'https://ads.example/pixel.js',
      ],
      staticPaths: [],
      streamingAssetsUrl: 'StreamingAssets',
      configBaseUrl: LOADER_BASE,
    });
    expect(limitReached).toBe(false);
    expect(urls.map((u) => u.url)).toEqual([
      'https://cdn.example/games/racer/Build/StreamingAssets/a.bank',
    ]);
  });

  it('9: deduplicates identical and repeated requests', () => {
    const d = discovery();
    const { urls } = d.resolveCandidates({
      observedUrls: [
        'https://cdn.example/b/StreamingAssets/a.bank',
        'https://cdn.example/b/StreamingAssets/a.bank?v=2',
        'https://cdn.example/b/StreamingAssets/a.bank',
      ],
      staticPaths: ['StreamingAssets/a.bank'],
      streamingAssetsUrl: 'StreamingAssets',
      configBaseUrl: 'https://cdn.example/b/g.loader.js',
    });
    expect(urls).toHaveLength(1);
    expect(urls[0].path).toBe('StreamingAssets/a.bank');
  });

  it('10: enforces the maximum file count with a limit flag', () => {
    const d = discovery();
    const observed = Array.from(
      { length: 10 },
      (_, i) => `https://cdn.example/b/StreamingAssets/f${i}.bank`,
    );
    const { urls, limitReached } = d.resolveCandidates({
      observedUrls: observed,
      staticPaths: [],
      streamingAssetsUrl: 'StreamingAssets',
      configBaseUrl: 'https://cdn.example/b/g.loader.js',
      maxFiles: 3,
    });
    expect(urls).toHaveLength(3);
    expect(limitReached).toBe(true);
  });
});

describe('unity.streaming-assets download', () => {
  function discoveryWith(
    bodies: Record<string, Buffer | Error>,
  ): UnityStreamingAssetsDiscovery {
    const downloader = {
      fetchBuffer: async (url: string) => {
        const hit = bodies[url];
        if (hit instanceof Error) throw hit;
        if (!hit) throw new Error(`Fake 404 for ${url}`);
        return {
          finalUrl: url,
          status: 200,
          body: hit,
          redirected: false,
        };
      },
    } as unknown as SecureDownloader;
    return new UnityStreamingAssetsDiscovery(
      downloader,
      new SourcePolicyService(),
    );
  }

  it('11: enforces the maximum total bytes', async () => {
    const d = discoveryWith({
      'https://cdn.example/b/StreamingAssets/a.bank': Buffer.alloc(10, 1),
      'https://cdn.example/b/StreamingAssets/b.bank': Buffer.alloc(10, 2),
    });
    const written = new Map<string, Buffer>();
    const res = await d.downloadAll(
      [
        {
          url: 'https://cdn.example/b/StreamingAssets/a.bank',
          path: 'StreamingAssets/a.bank',
        },
        {
          url: 'https://cdn.example/b/StreamingAssets/b.bank',
          path: 'StreamingAssets/b.bank',
        },
      ],
      {
        maxTotalBytes: 15,
        writeFile: async (p, bytes) => {
          written.set(p, bytes);
        },
      },
    );
    expect(res.files).toHaveLength(1);
    expect(res.limitReached).toBe(true);
    expect(written.has('StreamingAssets/a.bank')).toBe(true);
    expect(written.has('StreamingAssets/b.bank')).toBe(false);
  });

  it('12: reports failed dependency downloads without aborting the rest', async () => {
    const d = discoveryWith({
      'https://cdn.example/b/StreamingAssets/good.bank': Buffer.from('ok'),
      'https://cdn.example/b/StreamingAssets/bad.bank': new Error(
        'Fake network failure',
      ),
    });
    const written = new Map<string, Buffer>();
    const res = await d.downloadAll(
      [
        {
          url: 'https://cdn.example/b/StreamingAssets/bad.bank',
          path: 'StreamingAssets/bad.bank',
        },
        {
          url: 'https://cdn.example/b/StreamingAssets/good.bank',
          path: 'StreamingAssets/good.bank',
        },
      ],
      {
        writeFile: async (p, bytes) => {
          written.set(p, bytes);
        },
      },
    );
    expect(res.files.map((f) => f.path)).toEqual(['StreamingAssets/good.bank']);
    const codes = res.diagnostics.map((x) => x.code);
    expect(codes).toContain(
      DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_FAILED,
    );
    expect(codes).toContain(
      DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_COMPLETED,
    );
  });

  it('13: preserves nested destination paths on write', async () => {
    const d = discoveryWith({
      'https://cdn.example/b/StreamingAssets/audio/nested/x.bank':
        Buffer.from('bank'),
    });
    const written = new Map<string, Buffer>();
    const res = await d.downloadAll(
      [
        {
          url: 'https://cdn.example/b/StreamingAssets/audio/nested/x.bank',
          path: 'StreamingAssets/audio/nested/x.bank',
        },
      ],
      {
        writeFile: async (p, bytes) => {
          written.set(p, bytes);
        },
      },
    );
    expect(res.files[0].path).toBe('StreamingAssets/audio/nested/x.bank');
    expect(written.has('StreamingAssets/audio/nested/x.bank')).toBe(true);
  });
});

describe('unity config discovery StreamingAssets hint signal', () => {
  const LOADER_URL = 'https://cdn.example/Build/g.loader.js';
  const ENTRY_URL = 'https://cdn.example/index.html';
  const noFetch = async (): Promise<string> => {
    throw new Error('external fetch must not happen');
  };
  const discovery = (): UnityConfigDiscovery =>
    new UnityConfigDiscovery(
      new UnityLoaderParser(),
      new SourcePolicyService(),
    );

  it('synthesizes streamingAssetsUrl from adapter hints carrying the prefix', async () => {
    const d = await discovery().discover({
      loaderJs: 'var cfg={dataUrl:"g.data"};',
      loaderUrl: LOADER_URL,
      entryHtml: '<html></html>',
      entryUrl: ENTRY_URL,
      adapterAssetUrls: [
        'https://cdn.example/Build/g.framework.js',
        'https://cdn.example/Build/g.wasm',
        'https://files.example/g/77/StreamingAssets',
      ],
      fetchExternalScript: noFetch,
    });
    expect(d.build.streamingAssetsUrl).toBe(
      'https://files.example/g/77/StreamingAssets/',
    );
  });

  it('never invents a prefix signal when hints carry none', async () => {
    const d = await discovery().discover({
      loaderJs: 'var cfg={dataUrl:"g.data"};',
      loaderUrl: LOADER_URL,
      entryHtml: '<html></html>',
      entryUrl: ENTRY_URL,
      adapterAssetUrls: [
        'https://cdn.example/Build/g.framework.js',
        'https://cdn.example/Build/g.wasm',
      ],
      fetchExternalScript: noFetch,
    });
    expect(d.build.streamingAssetsUrl).toBeUndefined();
  });

  it('explicit loader values win over hint prefixes', async () => {
    const d = await discovery().discover({
      loaderJs: 'var cfg={dataUrl:"g.data",streamingAssetsUrl:"custom/SA"};',
      loaderUrl: LOADER_URL,
      entryHtml: '<html></html>',
      entryUrl: ENTRY_URL,
      adapterAssetUrls: [
        'https://cdn.example/Build/g.framework.js',
        'https://cdn.example/Build/g.wasm',
        'https://files.example/g/77/StreamingAssets',
      ],
      fetchExternalScript: noFetch,
    });
    // Explicit relative value is preserved as-is (resolved later).
    expect(d.build.streamingAssetsUrl).toBe('custom/SA');
  });
});

describe('unity importer StreamingAssets end to end (static signals)', () => {
  const ENTRY_URL = 'https://cdn.example/games/racer/index.html';
  const LOADER_URL = 'https://cdn.example/games/racer/Build/g.loader.js';
  const FRAMEWORK_URL = 'https://cdn.example/games/racer/Build/g.framework.js';
  const DATA_URL = 'https://cdn.example/games/racer/Build/g.data';
  const WASM_URL = 'https://cdn.example/games/racer/Build/g.wasm';
  const BANK_URL =
    'https://cdn.example/games/racer/Build/StreamingAssets/audio/Master.bank';
  const STRINGS_URL =
    'https://cdn.example/games/racer/Build/StreamingAssets/Master.strings.bank';

  const ENTRY_HTML =
    '<html><head><script src="Build/g.loader.js"></script></head>' +
    '<body><canvas id="unity-canvas"></canvas></body></html>';
  const LOADER_JS =
    'var cfg={dataUrl:"g.data",frameworkUrl:"g.framework.js",' +
    'codeUrl:"g.wasm",streamingAssetsUrl:"StreamingAssets"};';
  const FRAMEWORK_JS =
    'fetch("StreamingAssets/audio/Master.bank");' +
    'var s="StreamingAssets/Master.strings.bank";';

  function fakeDownloader(): SecureDownloader {
    const map: Record<string, Buffer> = {
      [ENTRY_URL]: Buffer.from(ENTRY_HTML),
      [LOADER_URL]: Buffer.from(LOADER_JS),
      [FRAMEWORK_URL]: Buffer.from(FRAMEWORK_JS),
      [DATA_URL]: Buffer.from('DATA'.repeat(10)),
      [WASM_URL]: Buffer.from('WASM'.repeat(10)),
      [BANK_URL]: Buffer.from('BANKDATA'),
      [STRINGS_URL]: Buffer.from('STRINGSDATA'),
    };
    return {
      fetchBuffer: async (url: string) => {
        const body = map[url];
        if (!body) throw new Error(`Fake 404 for ${url}`);
        return {
          finalUrl: url,
          status: 200,
          body,
          redirected: false,
        };
      },
    } as unknown as SecureDownloader;
  }

  it('13+14: downloads StreamingAssets into the package and lists them in the manifest', async () => {
    process.env.UNITY_STREAMING_ASSETS_RUNTIME_DISCOVERY = 'false';
    process.env.UNITY_STREAMING_ASSETS_LOCAL_DISCOVERY = 'false';
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
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pkg-'));
    const collected: string[] = [];
    const pkg = await importer.import({
      jobId: 'sa-test',
      sourceUrl: ENTRY_URL,
      workDir,
      limits: defaultImportLimits(),
      collectDiagnostics: (d) => {
        collected.push(d.code);
      },
    });
    const paths = pkg.files.map((f) => f.path);
    expect(paths).toContain('StreamingAssets/audio/Master.bank');
    expect(paths).toContain('StreamingAssets/Master.strings.bank');
    // On-disk layout mirrors the manifest (nested, not flattened).
    expect(
      fs.existsSync(
        path.join(pkg.rootPath, 'StreamingAssets', 'audio', 'Master.bank'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(pkg.rootPath, 'StreamingAssets', 'Master.strings.bank'),
      ),
    ).toBe(true);
    // Manifest inclusion with coherent counts/sizes.
    const manifestPaths = (pkg.manifest.assets ?? []).map((a) => a.path);
    expect(manifestPaths).toContain('StreamingAssets/audio/Master.bank');
    expect(manifestPaths).toContain('StreamingAssets/Master.strings.bank');
    expect(pkg.manifest.fileCount).toBe(pkg.files.length);
    expect(pkg.manifest.totalBytes).toBe(
      pkg.files.reduce((a, f) => a + f.bytes, 0),
    );
    expect(collected).toContain(
      DiagnosticCode.UNITY_STREAMING_ASSET_DOWNLOAD_COMPLETED,
    );
    expect(collected).toContain(
      DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_COMPLETED,
    );
  });

  it('discovers static refs even without an explicit prefix signal', async () => {
    process.env.UNITY_STREAMING_ASSETS_RUNTIME_DISCOVERY = 'false';
    process.env.UNITY_STREAMING_ASSETS_LOCAL_DISCOVERY = 'false';
    const downloader = {
      fetchBuffer: async (url: string) => {
        const map: Record<string, Buffer> = {
          [ENTRY_URL]: Buffer.from(ENTRY_HTML),
          [LOADER_URL]: Buffer.from(
            'var cfg={dataUrl:"g.data",frameworkUrl:"g.framework.js",codeUrl:"g.wasm"};',
          ),
          [FRAMEWORK_URL]: Buffer.from(FRAMEWORK_JS),
          [DATA_URL]: Buffer.from('DATA'.repeat(10)),
          [WASM_URL]: Buffer.from('WASM'.repeat(10)),
          [BANK_URL]: Buffer.from('BANKDATA'),
          [STRINGS_URL]: Buffer.from('STRINGSDATA'),
        };
        const body = map[url];
        if (!body) throw new Error(`Fake 404 for ${url}`);
        return { finalUrl: url, status: 200, body, redirected: false };
      },
    } as unknown as SecureDownloader;
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
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-nosig-'));
    const pkg = await importer.import({
      jobId: 'sa-nosig',
      sourceUrl: ENTRY_URL,
      workDir,
      limits: defaultImportLimits(),
    });
    const paths = pkg.files.map((f) => f.path);
    expect(paths).toContain('StreamingAssets/audio/Master.bank');
    expect(paths).toContain('StreamingAssets/Master.strings.bank');
  });
});

describe('unity StreamingAssets local-package observation', () => {
  it('records StreamingAssets requests a booting local package makes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-local-'));
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<html><body><canvas></canvas><script>
fetch("StreamingAssets/audio/x.bank");
fetch("StreamingAssets/y.bank?v=2");
</script></body></html>`,
    );
    const discovery = new UnityStreamingAssetsDiscovery(
      {} as SecureDownloader,
      new SourcePolicyService(),
    );
    const { paths, diagnostics } = await discovery.observeLocalPaths({
      pkgDir: dir,
      timeoutMs: 15000,
    });
    expect(paths).toContain('StreamingAssets/audio/x.bank');
    expect(paths).toContain('StreamingAssets/y.bank');
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain(
      DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_STARTED,
    );
    expect(codes).toContain(DiagnosticCode.UNITY_STREAMING_ASSET_DISCOVERED);
    expect(codes).toContain(
      DiagnosticCode.UNITY_STREAMING_ASSETS_DISCOVERY_COMPLETED,
    );
  }, 60000);
});
