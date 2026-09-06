import {
  InitEvaluation,
  InitSnapshot,
  RuntimeAssetKind,
} from './runtime.types';

const REQUIRED_KINDS: RuntimeAssetKind[] = ['loader', 'framework', 'wasm'];

/**
 * Pure multi-signal Unity initialization evaluation (M3).
 *
 * No single hardcoded selector decides the verdict. Signals:
 * - Unity canvas exists in the DOM
 * - loader / framework / wasm requests completed with HTTP 200
 *   (data required when a .data request was observed)
 * - explicit ready flag (window.unityInitialized et al.)
 * - Unity-flavored "initialized/ready" console message (supporting only)
 * - zero fatal page errors, zero failed required-artifact requests
 *
 * Verdict: canvas + no fatal errors + no failed required requests +
 * (explicit ready flag OR full observed asset load). A console message
 * alone never confirms initialization — packager-injected log lines must
 * not be able to satisfy the check by themselves. Anything less confident
 * is NOT initialization (caller reports RUNTIME_TIMEOUT).
 */
export function evaluateInitSignals(snapshot: InitSnapshot): InitEvaluation {
  const matched: string[] = [];
  const missing: string[] = [];

  if (snapshot.canvasPresent) matched.push('canvas');
  else missing.push('canvas');

  const loaded = new Set(snapshot.loadedKinds);
  const attempted = new Set(snapshot.attemptedKinds);
  const kindsToCheck: RuntimeAssetKind[] = [...REQUIRED_KINDS];
  if (attempted.has('data')) kindsToCheck.push('data');
  let assetsComplete = true;
  for (const kind of kindsToCheck) {
    if (loaded.has(kind)) {
      matched.push(`${kind}-loaded`);
    } else if (!attempted.has(kind)) {
      missing.push(`${kind}-not-observed`);
      assetsComplete = false;
    } else {
      missing.push(`${kind}-not-loaded`);
      assetsComplete = false;
    }
  }

  if (snapshot.explicitReady) matched.push('explicit-ready');
  else missing.push('explicit-ready');

  if (snapshot.consolePatternMatched) matched.push('console-init-message');
  else missing.push('console-init-message');

  if (snapshot.fatalErrors.length === 0) matched.push('no-page-errors');
  else missing.push('page-errors');

  if (snapshot.failedRequired.length === 0) matched.push('no-failed-assets');
  else missing.push('failed-required-assets');

  const confirmed = snapshot.explicitReady || assetsComplete;
  const initialized =
    snapshot.canvasPresent &&
    snapshot.fatalErrors.length === 0 &&
    snapshot.failedRequired.length === 0 &&
    confirmed;

  return { initialized, matchedSignals: matched, missingSignals: missing };
}

/** Classify a request URL pathname into a runtime artifact kind. */
export function classifyAssetKind(url: string): RuntimeAssetKind {
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }
  if (pathname.endsWith('.loader.js')) return 'loader';
  if (pathname.endsWith('.framework.js')) return 'framework';
  if (pathname.endsWith('.wasm')) return 'wasm';
  if (pathname.endsWith('.data')) return 'data';
  return 'other';
}

/** Explicit ready flags probed inside the page (any one suffices). */
export const EXPLICIT_READY_FLAGS = [
  'unityInitialized',
  '__UNITY_INITIALIZED__',
  'unityGameReady',
  'unityInstance',
] as const;

/** Console text suggesting Unity runtime initialization. */
export function matchesInitConsoleMessage(text: string): boolean {
  return (
    /unity/i.test(text) &&
    /initiali[sz]ed|loaded|ready|started|running|success/i.test(text)
  );
}
