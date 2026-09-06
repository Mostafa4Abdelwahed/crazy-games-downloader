import { UnityLoaderParser, findLoaderUrlInHints } from './unity.loader-parser';

describe('Unity caller-config static parsing (M3.1)', () => {
  const parser = new UnityLoaderParser();

  it('classifies inline-object vs variable vs unknown call args', () => {
    const calls = parser.findCreateInstanceCalls(
      'createUnityInstance(c, {dataUrl: "g.data"}); ' +
        'createUnityInstance(c, cfg); ' +
        'createUnityInstance(c, getConfig());',
    );
    expect(calls.map((c) => c.kind)).toEqual([
      'inline-object',
      'variable',
      'unknown',
    ]);
    expect(calls[0].objectText).toContain('dataUrl');
    expect(calls[1].varName).toBe('cfg');
  });

  it('ignores function definitions and commented-out calls', () => {
    const calls = parser.findCreateInstanceCalls(
      '// createUnityInstance(c, {dataUrl: "x.data"});\n' +
        '/* createUnityInstance(c, cfg); */\n' +
        'function createUnityInstance(t, n, d) { return n; }\n' +
        'createUnityInstance(canvas, realCfg);',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].varName).toBe('realCfg');
  });

  it('handles minified multi-line calls with nested parens', () => {
    const calls = parser.findCreateInstanceCalls(
      'createUnityInstance(document.querySelector("#c"),\n{dataUrl:"g.data",\nframeworkUrl:"g.framework.js"},\nfunction(){});',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('inline-object');
    const raw = parser.parseConfigObject(calls[0].objectText ?? '');
    expect(raw['dataUrl']).toBe('g.data');
  });

  it('resolves the last variable declaration textually', () => {
    const raw = parser.resolveConfigVariable(
      'var config = {dataUrl: "old.data"}; var config = {dataUrl: "new.data"}; createUnityInstance(c, config);',
      'config',
    );
    expect(raw?.['dataUrl']).toBe('new.data');
  });

  it('rejects unsafe variable names and non-object assignments', () => {
    expect(
      parser.resolveConfigVariable('var x = {dataUrl: "g.data"};', '__proto__'),
    ).toBeNull();
    expect(
      parser.resolveConfigVariable(
        'var config = getConfig(); createUnityInstance(c, config);',
        'config',
      ),
    ).toBeNull();
    expect(parser.resolveConfigVariable('var a = 1;', 'missing')).toBeNull();
  });

  it('extracts inline scripts but skips src and JSON blocks', () => {
    const blocks = parser.extractInlineScripts(
      '<script src="a.js"></script>' +
        '<script>var x = 1;</script>' +
        '<script id="__NEXT_DATA__" type="application/json">{"dataUrl":"x"}</script>' +
        '<script type="text/javascript">var y = 2;</script>',
    );
    expect(blocks).toEqual(['var x = 1;', 'var y = 2;']);
  });

  it('extracts external script urls in order, deduped', () => {
    expect(
      parser.extractExternalScriptUrls(
        '<script src="a.js"></script><script>var x;</script><script src="a.js"></script><script src="b.js">',
      ),
    ).toEqual(['a.js', 'b.js']);
  });

  it('rewrites only known keys inside inline scripts', () => {
    const out = parser.rewriteInlineConfigRefs(
      '<script>var c={dataUrl:"https://cdn.example/Build/g.data",unrelated:"https://cdn.example/Build/g.data"};</script>' +
        '<script src="Build/g.loader.js"></script>' +
        '<script type="application/json">{"dataUrl":"https://cdn.example/Build/g.data"}</script>',
      { dataUrl: 'Build/g.data' },
    );
    expect(out).toContain('dataUrl:"Build/g.data"');
    expect(out).toContain('unrelated:"https://cdn.example/Build/g.data"');
    expect(out).toContain('src="Build/g.loader.js"');
    expect(out).toContain('{"dataUrl":"https://cdn.example/Build/g.data"}');
  });

  it('finds loader urls in adapter hints by extension only', () => {
    expect(
      findLoaderUrlInHints([
        'https://cdn.example/Build/anything-here.loader.js',
        'https://cdn.example/Build/x.wasm',
      ]),
    ).toBe('https://cdn.example/Build/anything-here.loader.js');
    expect(
      findLoaderUrlInHints([
        'file:///etc/evil.loader.js',
        'https://cdn.example/x.wasm',
        'not-a-url',
      ]),
    ).toBeNull();
    expect(findLoaderUrlInHints([])).toBeNull();
  });
});
