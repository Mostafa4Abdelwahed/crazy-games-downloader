import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiagnosticCode } from '../core/diagnostics';
import { contentTypeForFile } from '../core/path-utils';
import { GamePackage } from '../core/types';
import { LocalPackageServer } from './local-package-server';
import { PlaywrightRuntimeValidator } from './playwright-runtime-validator';
import {
  evaluateInitSignals,
  isExtensionNoise,
  isStreamingAssetsRequestUrl,
  matchesFmodFailure,
} from './init-signals';
import { InitSnapshot } from './runtime.types';

function snapshot(over: Partial<InitSnapshot>): InitSnapshot {
  return {
    canvasPresent: true,
    loadedKinds: ['loader', 'framework', 'wasm'],
    attemptedKinds: ['loader', 'framework', 'wasm'],
    explicitReady: true,
    consolePatternMatched: false,
    fatalErrors: [],
    failedRequired: [],
    ...over,
  };
}

describe('runtime health beyond boot (StreamingAssets / FMOD / noise)', () => {
  it('15: a same-origin 404 fails the run even when boot passed', () => {
    const e = evaluateInitSignals(
      snapshot({
        failedLocal: [
          {
            url: 'http://127.0.0.1:9/StreamingAssets/Master.bank',
            status: 404,
          },
        ],
      }),
    );
    expect(e.initialized).toBe(false);
    expect(e.missingSignals).toContain('failed-game-assets');
  });

  it('16: succeeds when all packaged dependencies are present', () => {
    const e = evaluateInitSignals(
      snapshot({ failedLocal: [], fmodFailed: false }),
    );
    expect(e.initialized).toBe(true);
    expect(e.matchedSignals).toEqual(
      expect.arrayContaining(['no-failed-game-assets', 'no-fmod-failure']),
    );
  });

  it('fails on FMOD/bank-load signatures', () => {
    const e = evaluateInitSignals(snapshot({ fmodFailed: true }));
    expect(e.initialized).toBe(false);
    expect(e.missingSignals).toContain('fmod-failure');
  });

  it('17: ignores browser-extension noise', () => {
    expect(isExtensionNoise('Error in contentscript.js: boom')).toBe(true);
    expect(isExtensionNoise('ObjectMultiplex disposed')).toBe(true);
    expect(isExtensionNoise('MaxListenersExceededWarning: hello')).toBe(true);
    expect(isExtensionNoise('chrome-extension://abc/content.js')).toBe(true);
    expect(isExtensionNoise('FMOD: BankLoadException failed')).toBe(false);
  });

  it('detects FMOD/bank failures, never on noise or plain init lines', () => {
    expect(
      matchesFmodFailure(
        'FMOD: ERR_FORMAT Could not load bank StreamingAssets/Master.bank',
      ),
    ).toBe(true);
    expect(matchesFmodFailure('BankLoadException: Could not load bank')).toBe(
      true,
    );
    expect(matchesFmodFailure('Unity runtime initialized')).toBe(false);
    expect(matchesFmodFailure('ObjectMultiplex FMOD BankLoadException')).toBe(
      false,
    );
  });

  it('recognizes StreamingAssets request URLs', () => {
    expect(
      isStreamingAssetsRequestUrl(
        'http://127.0.0.1:9/StreamingAssets/Master.bank',
      ),
    ).toBe(true);
    expect(
      isStreamingAssetsRequestUrl(
        'http://127.0.0.1:9/StreamingAssets/audio/x.bank?v=1',
      ),
    ).toBe(true);
    expect(isStreamingAssetsRequestUrl('http://127.0.0.1:9/Build/g.wasm')).toBe(
      false,
    );
  });
});

function makePackage(files: Record<string, string>): GamePackage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-health-'));
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
      name: 'health',
      engine: 'unity',
      entryFile: 'index.html',
      createdAt: new Date().toISOString(),
      sourceUrl: 'synthetic://health',
      fileCount: list.length,
      totalBytes: list.reduce((a, f) => a + f.bytes, 0),
    },
    rootPath: dir,
    files: list,
  };
}

describe('playwright validator post-boot health', () => {
  const runtime = new PlaywrightRuntimeValidator(new LocalPackageServer());

  it('15: missing StreamingAssets banks fail an initialized package', async () => {
    const pkg = makePackage({
      'index.html': `<html><body><canvas id="unity-canvas"></canvas><script>
window.unityInitialized = true;
console.log("Unity runtime initialized");
fetch("StreamingAssets/Master.bank").then(function (r) {
  if (!r.ok) console.error("bank fetch failed: " + r.status);
});
</script></body></html>`,
    });
    const result = await runtime.validate(pkg, {
      timeoutMs: 15000,
      settleMs: 3000,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('RUNTIME_ERROR');
    expect(result.unityInitialized).toBe(false);
    expect(result.streamingAssetsFailures?.map((f) => f.url).join(' ')).toMatch(
      /Master\.bank/,
    );
    expect(result.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.UNITY_RUNTIME_ASSET_MISSING,
    );
  }, 60000);

  it('16: present StreamingAssets banks keep a healthy package green', async () => {
    const pkg = makePackage({
      'index.html': `<html><body><canvas id="unity-canvas"></canvas><script>
window.unityInitialized = true;
console.log("Unity runtime initialized");
fetch("StreamingAssets/Master.bank").then(function (r) {
  if (!r.ok) console.error("bank fetch failed: " + r.status);
});
</script></body></html>`,
      'StreamingAssets/Master.bank': 'BANKDATA'.repeat(10),
    });
    const result = await runtime.validate(pkg, {
      timeoutMs: 15000,
      settleMs: 1500,
    });
    expect(result.success).toBe(true);
    expect(result.code).toBe('RUNTIME_OK');
    expect(result.streamingAssetsFailures ?? []).toEqual([]);
  }, 60000);

  it('fails packages whose console reports FMOD bank-load errors', async () => {
    const pkg = makePackage({
      'index.html': `<html><body><canvas id="unity-canvas"></canvas><script>
window.unityInitialized = true;
console.log("Unity runtime initialized");
console.error("FMOD ERR_FORMAT BankLoadException: Could not load bank StreamingAssets/Master.bank");
</script></body></html>`,
      'StreamingAssets/Master.bank': 'BANKDATA',
    });
    const result = await runtime.validate(pkg, {
      timeoutMs: 15000,
      settleMs: 1500,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('RUNTIME_ERROR');
    expect(result.fmodFailed).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.UNITY_RUNTIME_ASSET_MISSING,
    );
  }, 60000);
});
