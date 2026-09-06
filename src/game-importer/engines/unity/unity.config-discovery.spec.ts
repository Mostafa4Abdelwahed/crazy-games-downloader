import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourcePolicyService } from '../../core/source-policy';
import { DiagnosticCode, ImportError } from '../../core/diagnostics';
import { UnityLoaderParser } from './unity.loader-parser';
import { UnityConfigDiscovery } from './unity.config-discovery';

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const LOADER_URL = 'https://cdn.example/Build/game.loader.js';
const ENTRY_URL = 'https://cdn.example/index.html';
const noFetch = async (): Promise<string> => {
  throw new Error('external fetch must not happen');
};

function buildDiscovery(): UnityConfigDiscovery {
  return new UnityConfigDiscovery(
    new UnityLoaderParser(),
    new SourcePolicyService(),
  );
}

describe('Unity config discovery (M3.1)', () => {
  const OLD_HOSTS = process.env.SOURCE_ALLOWED_HOSTS;
  const OLD_ANY = process.env.ALLOW_ANY_HTTPS;
  beforeEach(() => {
    process.env.SOURCE_ALLOWED_HOSTS = 'cdn.example,assets.example';
    process.env.ALLOW_ANY_HTTPS = 'false';
  });
  afterEach(() => {
    if (OLD_HOSTS === undefined) delete process.env.SOURCE_ALLOWED_HOSTS;
    else process.env.SOURCE_ALLOWED_HOSTS = OLD_HOSTS;
    if (OLD_ANY === undefined) delete process.env.ALLOW_ANY_HTTPS;
    else process.env.ALLOW_ANY_HTTPS = OLD_ANY;
  });

  const codesOf = (d: { diagnostics: Array<{ code: string }> }): string[] =>
    d.diagnostics.map((x) => x.code);

  // Test A — direct config in loader.
  it('A: resolves direct config literals from loader text', async () => {
    const discovery = buildDiscovery();
    const d = await discovery.discover({
      loaderJs:
        'createUnityInstance(canvas, {dataUrl: "game.data", frameworkUrl: "game.framework.js", codeUrl: "game.wasm"});',
      loaderUrl: LOADER_URL,
      entryHtml: '<html><body></body></html>',
      entryUrl: ENTRY_URL,
      fetchExternalScript: noFetch,
    });
    expect(d.source).toBe('loader');
    expect(d.build.dataUrl).toBe('game.data');
    expect(d.build.frameworkUrl).toBe('game.framework.js');
    expect(d.build.codeUrl).toBe('game.wasm');
    expect(d.configBaseUrl).toBe(LOADER_URL);
    expect(codesOf(d)).toContain(DiagnosticCode.UNITY_CONFIG_FROM_LOADER);
  });

  // Test B — config variable + createUnityInstance(canvas, config).
  it('B: resolves variable-based caller config without execution', async () => {
    const discovery = buildDiscovery();
    const d = await discovery.discover({
      loaderJs: read('generic-loader.stub.js'),
      loaderUrl: LOADER_URL,
      entryHtml: read('caller-variable-config.html'),
      entryUrl: ENTRY_URL,
      fetchExternalScript: noFetch,
    });
    expect(d.source).toBe('caller');
    expect(d.build.dataUrl).toBe('Build/fixture-racer.data');
    expect(d.build.frameworkUrl).toBe('Build/fixture-racer.framework.js');
    expect(d.build.codeUrl).toBe('Build/fixture-racer.wasm');
    expect(d.configBaseUrl).toBe(ENTRY_URL);
    expect(codesOf(d)).toContain(DiagnosticCode.UNITY_CONFIG_FROM_CALLER);
    expect(codesOf(d)).toContain(DiagnosticCode.UNITY_CONFIG_VARIABLE_RESOLVED);
  });

  it('B2: resolves inline-object caller config', async () => {
    const discovery = buildDiscovery();
    const d = await discovery.discover({
      loaderJs: read('generic-loader.stub.js'),
      loaderUrl: LOADER_URL,
      entryHtml: read('caller-inline-config.html'),
      entryUrl: ENTRY_URL,
      fetchExternalScript: noFetch,
    });
    expect(d.source).toBe('caller');
    expect(d.build.dataUrl).toBe('Build/fixture-racer.data');
  });

  it('ignores computed (non-literal) config values instead of guessing', () => {
    const parser = new UnityLoaderParser();
    const raw = parser.resolveCallerConfig(
      'var config = { dataUrl: buildUrl + "/g.data", frameworkUrl: "g.framework.js" }; createUnityInstance(c, config);',
    );
    expect(raw?.raw.frameworkUrl).toBe('g.framework.js');
    expect(raw?.raw.dataUrl).toBeUndefined();
  });

  // Test C — generic loader with property reads only.
  it('C: fails closed when only m.dataUrl-style reads exist', async () => {
    const discovery = buildDiscovery();
    let caught: unknown;
    try {
      await discovery.discover({
        loaderJs: read('generic-loader.stub.js'),
        loaderUrl: LOADER_URL,
        entryHtml: '<html><body><canvas></canvas></body></html>',
        entryUrl: ENTRY_URL,
        fetchExternalScript: noFetch,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).code).toBe(
      DiagnosticCode.UNITY_CONFIG_NOT_FOUND,
    );
    expect((caught as Error).message).toMatch(/No Unity build configuration/);
  });

  // Test D — sanitized real-loader structure never yields fake URLs.
  it('D: real-loader variant yields no hallucinated URLs', () => {
    const parser = new UnityLoaderParser();
    const stub = read('generic-loader.stub.js');
    // Member reads are detected as expectation signals...
    expect(stub).toMatch(/m\.dataUrl/);
    expect(stub).toMatch(/m\.frameworkUrl/);
    expect(stub).toMatch(/m\.codeUrl/);
    expect(stub).toMatch(/streamingAssetsUrl:\s*['"]StreamingAssets['"]/);
    // ...but parse directly throws: no literal values present.
    expect(() => parser.parse(stub)).toThrow(ImportError);
    try {
      parser.parse(stub);
    } catch (e) {
      const diags = (e as ImportError).diagnostics.map((x) => x.code);
      expect(diags).toContain(DiagnosticCode.UNITY_CREATE_INSTANCE_FOUND);
      expect(diags).toContain(DiagnosticCode.UNITY_CONFIG_NOT_FOUND);
    }
    // And caller resolution finds no call with values here either.
    expect(parser.findCreateInstanceCalls(stub)).toEqual([]);
    expect(parser.resolveCallerConfig(stub)).toBeNull();
  });

  // Test E — relative refs resolve against the right base per stage.
  it('E: caller-relative refs use the entry URL as base', async () => {
    const discovery = buildDiscovery();
    const d = await discovery.discover({
      loaderJs: read('generic-loader.stub.js'),
      loaderUrl: LOADER_URL,
      entryHtml: read('caller-inline-config.html'),
      entryUrl: 'https://cdn.example/games/fixture/index.html',
      fetchExternalScript: noFetch,
    });
    expect(d.source).toBe('caller');
    expect(d.configBaseUrl).toBe(
      'https://cdn.example/games/fixture/index.html',
    );
    expect(d.build.dataUrl).toBe('Build/fixture-racer.data');
  });

  // Test F — invalid/non-http hints fail closed (ignored, never fetched).
  it('F: non-http adapter hints are ignored, never resolved', async () => {
    const discovery = buildDiscovery();
    const d = await discovery.discover({
      loaderJs: 'var cfg={frameworkUrl:"g.framework.js",codeUrl:"g.wasm"};',
      loaderUrl: LOADER_URL,
      entryHtml: '<html></html>',
      entryUrl: ENTRY_URL,
      adapterAssetUrls: [
        'file:///etc/passwd',
        'javascript:alert(1)',
        'https://cdn.example/Build/g.data',
      ],
      fetchExternalScript: noFetch,
    });
    expect(d.source).toBe('loader');
    expect(d.build.dataUrl).toBe('https://cdn.example/Build/g.data');
    expect(d.build.frameworkUrl).toBe('g.framework.js');
  });

  it('loader stage wins over caller and adapter hints', async () => {
    const discovery = buildDiscovery();
    const d = await discovery.discover({
      loaderJs:
        'var cfg={dataUrl:"Build/from-loader.data",frameworkUrl:"Build/from-loader.framework.js",codeUrl:"Build/from-loader.wasm"};',
      loaderUrl: LOADER_URL,
      entryHtml: read('caller-inline-config.html'),
      entryUrl: ENTRY_URL,
      adapterAssetUrls: ['https://cdn.example/Build/from-hints.data'],
      fetchExternalScript: noFetch,
    });
    expect(d.source).toBe('loader');
    expect(d.build.dataUrl).toBe('Build/from-loader.data');
  });

  it('adapter hints fill gaps without overriding explicit values', async () => {
    const discovery = buildDiscovery();
    const d = await discovery.discover({
      loaderJs: 'var cfg={dataUrl:"Build/partial.data"};',
      loaderUrl: LOADER_URL,
      entryHtml: '<html></html>',
      entryUrl: ENTRY_URL,
      adapterAssetUrls: [
        'https://cdn.example/Build/other.data',
        'https://cdn.example/Build/other.framework.js',
        'https://cdn.example/Build/other.wasm',
      ],
      fetchExternalScript: noFetch,
    });
    expect(d.source).toBe('loader');
    expect(d.build.dataUrl).toBe('Build/partial.data');
    expect(d.build.frameworkUrl).toBe(
      'https://cdn.example/Build/other.framework.js',
    );
    expect(d.build.codeUrl).toBe('https://cdn.example/Build/other.wasm');
    expect(codesOf(d)).toContain(
      DiagnosticCode.UNITY_CONFIG_FROM_ADAPTER_HINTS,
    );
  });

  it('synthesizes config purely from adapter hints when nothing else exists', async () => {
    const discovery = buildDiscovery();
    const d = await discovery.discover({
      loaderJs: read('generic-loader.stub.js'),
      loaderUrl: 'https://cdn.example/Build/qzx.loader.js',
      entryHtml: '<html></html>',
      entryUrl: ENTRY_URL,
      adapterAssetUrls: [
        'https://cdn.example/Build/qzx.loader.js',
        'https://cdn.example/Build/qzx.data.br',
        'https://cdn.example/Build/qzx.framework.js.br',
        'https://cdn.example/Build/qzx.wasm.br',
      ],
      fetchExternalScript: noFetch,
    });
    expect(d.source).toBe('adapter-hints');
    expect(d.build.loaderUrl).toBe('https://cdn.example/Build/qzx.loader.js');
    expect(d.build.dataUrl).toBe('https://cdn.example/Build/qzx.data.br');
    expect(d.build.codeUrl).toBe('https://cdn.example/Build/qzx.wasm.br');
  });

  it('resolves config from explicitly referenced external scripts', async () => {
    const discovery = buildDiscovery();
    const scriptUrl = 'https://cdn.example/js/fixture-config.js';
    const fetched: string[] = [];
    const d = await discovery.discover({
      loaderJs: read('generic-loader.stub.js'),
      loaderUrl: LOADER_URL,
      entryHtml: `<html><body><script src="Build/game.loader.js"></script><script src="${scriptUrl}"></script></body></html>`,
      entryUrl: ENTRY_URL,
      fetchExternalScript: async (url: string) => {
        fetched.push(url);
        expect(url).toBe(scriptUrl);
        return read('external-config.js');
      },
    });
    expect(d.source).toBe('external');
    expect(d.build.dataUrl).toBe('Build/fixture-external.data');
    expect(d.configBaseUrl).toBe(scriptUrl);
    expect(codesOf(d)).toContain(
      DiagnosticCode.UNITY_CONFIG_FROM_EXTERNAL_RESOURCE,
    );
  });

  it('skips unauthorized external scripts without fetching them', async () => {
    const discovery = buildDiscovery();
    const fetched: string[] = [];
    let caught: unknown;
    try {
      await discovery.discover({
        loaderJs: read('generic-loader.stub.js'),
        loaderUrl: LOADER_URL,
        entryHtml:
          '<html><body><script src="https://tracker.example/t.js"></script></body></html>',
        entryUrl: ENTRY_URL,
        fetchExternalScript: async (url: string) => {
          fetched.push(url);
          return read('external-config.js');
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(fetched).toEqual([]);
    expect((caught as ImportError).code).toBe(
      DiagnosticCode.UNITY_CONFIG_NOT_FOUND,
    );
    const diags = (caught as ImportError).diagnostics.map((x) => x.code);
    expect(diags).toContain(DiagnosticCode.EXTERNAL_REFERENCE);
  });

  it('continues past failed external fetches and caps script count', async () => {
    const discovery = buildDiscovery();
    const fetched: string[] = [];
    const refs = [1, 2, 3, 4]
      .map((n) => `<script src="https://cdn.example/js/c${n}.js"></script>`)
      .join('');
    let caught: unknown;
    try {
      await discovery.discover({
        loaderJs: read('generic-loader.stub.js'),
        loaderUrl: LOADER_URL,
        entryHtml: `<html><body>${refs}</body></html>`,
        entryUrl: ENTRY_URL,
        maxExternalScripts: 2,
        fetchExternalScript: async (url: string) => {
          fetched.push(url);
          throw new Error('Fake 404');
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(fetched).toEqual([
      'https://cdn.example/js/c1.js',
      'https://cdn.example/js/c2.js',
    ]);
    expect((caught as ImportError).code).toBe(
      DiagnosticCode.UNITY_CONFIG_NOT_FOUND,
    );
    const diags = (caught as ImportError).diagnostics.map((x) => x.code);
    expect(diags).toContain(DiagnosticCode.NETWORK_FAILURE);
  });

  it('emits discovery-started for every run', async () => {
    const discovery = buildDiscovery();
    const d = await discovery.discover({
      loaderJs: 'var cfg={dataUrl:"g.data"};',
      loaderUrl: LOADER_URL,
      entryHtml: '<html></html>',
      entryUrl: ENTRY_URL,
      fetchExternalScript: noFetch,
    });
    expect(codesOf(d)[0]).toBe(DiagnosticCode.UNITY_CONFIG_DISCOVERY_STARTED);
  });
});
