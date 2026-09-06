import { DiagnosticCode } from '../../core/diagnostics';
import { UnityLoaderParser } from './unity.loader-parser';
import { UnityAssetResolver } from './unity.asset-resolver';

describe('Unity loader variations (M3)', () => {
  const parser = new UnityLoaderParser();
  const resolver = new UnityAssetResolver();

  it.each([
    ['game.loader.js', 'game.data', 'game.framework.js', 'game.wasm'],
    ['abc.loader.js', 'abc.data', 'abc.framework.js', 'abc.wasm'],
    [
      'webgl-1.2.3.loader.js',
      'webgl-1.2.3.data',
      'webgl-1.2.3.framework.js',
      'webgl-1.2.3.wasm',
    ],
  ])(
    'parses alternate loader/asset names: %s',
    (loader, data, framework, wasm) => {
      const js = `var cfg={dataUrl:"Build/${data}",frameworkUrl:"Build/${framework}",codeUrl:"Build/${wasm}"};`;
      const { build } = parser.parse(js);
      expect(build.dataUrl).toBe(`Build/${data}`);
      expect(build.frameworkUrl).toBe(`Build/${framework}`);
      expect(build.wasmCodeUrl).toBe(`Build/${wasm}`);
      expect(loader).toContain('.loader.js');
    },
  );

  it('resolves relative URL variants against the loader base', () => {
    const base = 'https://example.com/game/Build/game.loader.js';
    const cases: Array<[string, string]> = [
      ['game.data', 'https://example.com/game/Build/game.data'],
      ['./game.data', 'https://example.com/game/Build/game.data'],
      ['Build/game.data', 'https://example.com/game/Build/Build/game.data'],
      ['../Build/game.data', 'https://example.com/game/Build/game.data'],
      [
        'https://example.com/game/Build/game.data',
        'https://example.com/game/Build/game.data',
      ],
    ];
    for (const [ref, expected] of cases) {
      const { build } = resolver.resolve(
        { loaderUrl: base, dataUrl: ref },
        base,
      );
      expect(build.dataUrl).toBe(expected);
    }
  });

  it('resolves refs relative to a nested entry URL', () => {
    const { build } = resolver.resolve(
      {
        loaderUrl: 'https://example.com/g/webgl/Build/a.loader.js',
        dataUrl: 'a.data',
      },
      'https://example.com/g/webgl/Build/a.loader.js',
    );
    expect(build.dataUrl).toBe('https://example.com/g/webgl/Build/a.data');
  });

  it('supports Brotli-suffixed asset references', () => {
    const { build, urls } = resolver.resolve(
      {
        loaderUrl: 'https://example.com/g/Build/g.loader.js',
        dataUrl: 'g.data.br',
        frameworkUrl: 'g.framework.js.br',
        codeUrl: 'g.wasm.br',
      },
      'https://example.com/g/Build/g.loader.js',
    );
    expect(urls).toHaveLength(3);
    expect(build.dataUrl).toBe('https://example.com/g/Build/g.data.br');
  });

  it('fails closed with a structured diagnostic when config is missing', () => {
    let caught: unknown;
    try {
      parser.parse('console.log("hello");');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe(
      DiagnosticCode.UNITY_CONFIG_NOT_FOUND,
    );
    expect((caught as Error).message).toMatch(/No Unity build configuration/);
  });

  it('records INVALID_REFERENCE for unsafe refs instead of resolving them', () => {
    const r = resolver.resolve(
      {
        loaderUrl: 'https://example.com/g/Build/g.loader.js',
        dataUrl: 'javascript:alert(1)',
        frameworkUrl: 'file:///etc/passwd',
        codeUrl: 'ftp://example.com/g.wasm',
      },
      'https://example.com/g/Build/g.loader.js',
    );
    expect(r.urls).toEqual([]);
    expect(r.build.dataUrl).toBeUndefined();
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain(DiagnosticCode.INVALID_REFERENCE);
    expect(r.diagnostics.every((d) => d.level === 'error')).toBe(true);
  });

  it('records INVALID_REFERENCE for empty refs', () => {
    const r = resolver.resolve(
      {
        loaderUrl: 'https://example.com/g/Build/g.loader.js',
        dataUrl: '   ',
      },
      'https://example.com/g/Build/g.loader.js',
    );
    expect(r.urls).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.INVALID_REFERENCE,
    );
  });

  it('keeps data:/blob: refs out of the download set', () => {
    const r = resolver.resolve(
      {
        loaderUrl: 'https://example.com/g/Build/g.loader.js',
        dataUrl: 'data:application/octet-stream;base64,AAA=',
        codeUrl: 'blob:https://example.com/uuid',
      },
      'https://example.com/g/Build/g.loader.js',
    );
    expect(r.urls).toEqual([]);
  });
});
