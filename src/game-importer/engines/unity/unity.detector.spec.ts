import { UnityDetector } from './unity.detector';

const UNITY_HTML = `
<!doctype html><html><head><title>Test Game</title></head><body>
<canvas id="unity-canvas"></canvas>
<script src="Build/game.loader.js"></script>
<script>
createUnityInstance(document.querySelector("#unity-canvas"), {
  dataUrl: "Build/game.data",
  frameworkUrl: "Build/game.framework.js",
  codeUrl: "Build/game.wasm",
  streamingAssetsUrl: "StreamingAssets",
});
</script>
</body></html>`;

describe('UnityDetector', () => {
  const detector = new UnityDetector();

  it('detects a Unity WebGL page with high confidence', async () => {
    const res = await detector.detect({
      sourceUrl: 'https://partner.example/game',
      html: UNITY_HTML,
      fileNames: ['Build/game.loader.js', 'Build/game.wasm'],
    });
    expect(res.engine).toBe('unity');
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);
    expect(res.signals.filter((s) => s.matched).length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('gives low confidence for non-Unity pages', async () => {
    const res = await detector.detect({
      sourceUrl: 'https://partner.example/blog',
      html: '<html><body><h1>Hello</h1></body></html>',
    });
    expect(res.confidence).toBeLessThan(0.5);
  });

  it('uses multiple signals, not a single filename', async () => {
    // A bare filename mention alone must not be enough.
    const res = await detector.detect({
      sourceUrl: 'https://partner.example/x',
      html: '<html><body>download game.wasm here</body></html>',
    });
    expect(res.confidence).toBeLessThan(0.5);
    const matched = res.signals.filter((s) => s.matched);
    expect(matched.length).toBeLessThanOrEqual(2);
  });

  it('never hardcodes partner-specific filenames', async () => {
    const res = await detector.detect({
      sourceUrl: 'https://partner.example/game',
      html: UNITY_HTML.replace(/game\./g, 'totally-different-name.'),
    });
    expect(res.engine).toBe('unity');
    expect(res.confidence).toBeGreaterThanOrEqual(0.5);
  });
});
