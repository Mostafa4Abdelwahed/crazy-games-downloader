import { UnityLoaderParser } from './unity.loader-parser';

describe('UnityLoaderParser', () => {
  const parser = new UnityLoaderParser();

  it('parses dataUrl/frameworkUrl/codeUrl from loader config', () => {
    const js = `
      var config = { dataUrl: "Build/mygame.data", frameworkUrl: "Build/mygame.framework.js", codeUrl: "Build/mygame.wasm", streamingAssetsUrl: "StreamingAssets" };
      createUnityInstance(canvas, config);
    `;
    const { build } = parser.parse(js);
    expect(build.dataUrl).toBe('Build/mygame.data');
    expect(build.frameworkUrl).toBe('Build/mygame.framework.js');
    expect(build.wasmCodeUrl).toBe('Build/mygame.wasm');
    expect(build.streamingAssetsUrl).toBe('StreamingAssets');
  });

  it('supports wasmCodeUrl spelling and single quotes', () => {
    const js = `createUnityInstance(c,{'dataUrl':'b/g.data','frameworkUrl':'b/g.framework.js','wasmCodeUrl':'b/g.wasm'});`;
    const { build } = parser.parse(js);
    expect(build.dataUrl).toBe('b/g.data');
    expect(build.wasmCodeUrl).toBe('b/g.wasm');
  });

  it('throws when no Unity config keys are present', () => {
    expect(() => parser.parse('console.log("hello");')).toThrow(
      /No Unity build configuration/,
    );
  });

  it('finds loader script urls in html', () => {
    const urls = parser.findLoaderScriptUrls(
      '<script src="Build/a.loader.js"></script><script src="https://cdn.example/b.js"></script>',
    );
    expect(urls).toEqual(['Build/a.loader.js', 'https://cdn.example/b.js']);
  });
});
