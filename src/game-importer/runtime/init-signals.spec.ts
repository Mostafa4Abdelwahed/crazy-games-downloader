import {
  EXPLICIT_READY_FLAGS,
  classifyAssetKind,
  evaluateInitSignals,
  matchesInitConsoleMessage,
} from './init-signals';
import { InitSnapshot } from './runtime.types';

function snapshot(over: Partial<InitSnapshot>): InitSnapshot {
  return {
    canvasPresent: false,
    loadedKinds: [],
    attemptedKinds: [],
    explicitReady: false,
    consolePatternMatched: false,
    fatalErrors: [],
    failedRequired: [],
    ...over,
  };
}

describe('init-signals', () => {
  it('initializes on full asset load + canvas + clean errors', () => {
    const e = evaluateInitSignals(
      snapshot({
        canvasPresent: true,
        loadedKinds: ['loader', 'framework', 'wasm', 'data'],
        attemptedKinds: ['loader', 'framework', 'wasm', 'data'],
      }),
    );
    expect(e.initialized).toBe(true);
    expect(e.matchedSignals).toEqual(
      expect.arrayContaining(['canvas', 'wasm-loaded', 'framework-loaded']),
    );
  });

  it('initializes on explicit flags even with partial asset evidence', () => {
    const e = evaluateInitSignals(
      snapshot({
        canvasPresent: true,
        loadedKinds: ['framework', 'wasm'],
        attemptedKinds: ['framework', 'wasm'],
        explicitReady: true,
      }),
    );
    expect(e.initialized).toBe(true);
  });

  it('does not initialize without a canvas', () => {
    const e = evaluateInitSignals(
      snapshot({
        loadedKinds: ['loader', 'framework', 'wasm', 'data'],
        attemptedKinds: ['loader', 'framework', 'wasm', 'data'],
        explicitReady: true,
      }),
    );
    expect(e.initialized).toBe(false);
    expect(e.missingSignals).toContain('canvas');
  });

  it('does not initialize with fatal page errors', () => {
    const e = evaluateInitSignals(
      snapshot({
        canvasPresent: true,
        loadedKinds: ['loader', 'framework', 'wasm', 'data'],
        attemptedKinds: ['loader', 'framework', 'wasm', 'data'],
        explicitReady: true,
        fatalErrors: ['Uncaught ReferenceError: x is not defined'],
      }),
    );
    expect(e.initialized).toBe(false);
    expect(e.missingSignals).toContain('page-errors');
  });

  it('does not initialize with failed required assets', () => {
    const e = evaluateInitSignals(
      snapshot({
        canvasPresent: true,
        loadedKinds: ['loader'],
        attemptedKinds: ['loader', 'framework'],
        failedRequired: [
          { url: 'http://127.0.0.1:1/Build/g.framework.js', status: 404 },
        ],
      }),
    );
    expect(e.initialized).toBe(false);
    expect(e.missingSignals).toContain('failed-required-assets');
  });

  it('requires data when a data request was observed', () => {
    const e = evaluateInitSignals(
      snapshot({
        canvasPresent: true,
        loadedKinds: ['loader', 'framework', 'wasm'],
        attemptedKinds: ['loader', 'framework', 'wasm', 'data'],
      }),
    );
    expect(e.initialized).toBe(false);
    expect(e.missingSignals).toContain('data-not-loaded');
  });

  it('does not initialize on a console message alone', () => {
    // Guards against self-confirmation: a packager-injected log line must
    // never satisfy the check without asset or flag evidence.
    const e = evaluateInitSignals(
      snapshot({
        canvasPresent: true,
        loadedKinds: ['loader', 'data'],
        attemptedKinds: ['loader', 'data'],
        consolePatternMatched: true,
      }),
    );
    expect(e.initialized).toBe(false);
    expect(e.matchedSignals).toContain('console-init-message');
    expect(e.missingSignals).toContain('explicit-ready');
  });

  it('classifies asset kinds from URLs', () => {
    expect(classifyAssetKind('http://127.0.0.1:9/Build/g.loader.js')).toBe(
      'loader',
    );
    expect(classifyAssetKind('http://127.0.0.1:9/Build/g.framework.js')).toBe(
      'framework',
    );
    expect(classifyAssetKind('http://127.0.0.1:9/Build/g.wasm')).toBe('wasm');
    expect(classifyAssetKind('http://127.0.0.1:9/Build/g.data')).toBe('data');
    expect(classifyAssetKind('http://127.0.0.1:9/js/app.js')).toBe('other');
  });

  it('matches Unity init console messages', () => {
    expect(matchesInitConsoleMessage('Unity runtime initialized')).toBe(true);
    expect(matchesInitConsoleMessage('unity instance ready')).toBe(true);
    expect(matchesInitConsoleMessage('hello world')).toBe(false);
    expect(matchesInitConsoleMessage('Unity asset failed')).toBe(false);
  });

  it('exposes the probed ready flags', () => {
    expect(EXPLICIT_READY_FLAGS).toContain('unityInitialized');
  });
});
