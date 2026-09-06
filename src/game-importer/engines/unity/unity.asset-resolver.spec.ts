import { UnityAssetResolver } from './unity.asset-resolver';

describe('UnityAssetResolver', () => {
  const resolver = new UnityAssetResolver();

  it('resolves relative asset refs against the loader base URL', () => {
    const { urls, build } = resolver.resolve(
      {
        loaderUrl: 'https://cdn.example/games/g/Build/g.loader.js',
        dataUrl: 'g.data',
        frameworkUrl: 'g.framework.js',
        wasmCodeUrl: 'g.wasm',
      },
      'https://cdn.example/games/g/Build/g.loader.js',
    );
    expect(build.dataUrl).toBe('https://cdn.example/games/g/Build/g.data');
    expect(build.frameworkUrl).toBe(
      'https://cdn.example/games/g/Build/g.framework.js',
    );
    expect(build.wasmCodeUrl).toBe('https://cdn.example/games/g/Build/g.wasm');
    expect(urls).toHaveLength(3);
  });

  it('keeps absolute URLs and dedupes', () => {
    const { urls } = resolver.resolve(
      {
        loaderUrl: 'https://cdn.example/g.loader.js',
        dataUrl: 'https://cdn.example/g.data',
        codeUrl: 'https://cdn.example/g.data',
      },
      'https://cdn.example/g.loader.js',
    );
    expect(urls).toEqual(['https://cdn.example/g.data']);
  });

  it('only rewrites known config keys, never blind global replacement', () => {
    const js = 'var dataUrl="OLD"; var unrelated="OLD";';
    const out = resolver.rewriteKnownConfigRefs(js, {
      dataUrl: 'NEW',
      unrelated: 'HACKED',
    });
    expect(out).toContain('dataUrl="NEW"');
    expect(out).toContain('unrelated="OLD"');
  });
});
