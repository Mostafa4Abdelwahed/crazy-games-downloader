import { Injectable } from '@nestjs/common';
import { scoreSignals } from '../../core/detector';
import {
  DetectionContext,
  DetectionResult,
  DetectionSignal,
} from '../../core/types';

/**
 * Unity WebGL detector using multiple weighted signals + confidence scoring.
 * Never relies on a single filename/regex. Supports generic Unity WebGL
 * build layouts (no hardcoded partner-specific names like y8.data) AND
 * content-hashed builds (e.g. `962b….js` instead of `game.loader.js`)
 * whose files carry no conventional extensions.
 */
@Injectable()
export class UnityDetector {
  async detect(context: DetectionContext): Promise<DetectionResult> {
    const signals: DetectionSignal[] = [];
    const html = (context.html ?? '').slice(0, 500_000);
    const portalHtml = (context.portalHtml ?? '').slice(0, 500_000);
    const names = (context.fileNames ?? []).map((n) => n.toLowerCase());
    const probeKeys = Object.keys(context.probes ?? {}).map((k) =>
      k.toLowerCase(),
    );
    const allNames = [...names, ...probeKeys];

    // Signals apply to the entry HTML and, when provided, the portal/wrapper
    // page HTML (`__NEXT_DATA__` delivery config lives there even when the
    // game frame is a JS-bootstrapped shell with no static Unity markers).
    const has = (re: RegExp) => re.test(html) || re.test(portalHtml);

    signals.push({
      name: 'unity-loader-instantiation',
      weight: 3,
      matched:
        has(/createunityinstance/i) ||
        has(/unityinstance/i) ||
        has(/unityloader\.instantiate/i),
      detail: 'createUnityInstance / UnityLoader.instantiate present',
    });

    signals.push({
      name: 'unity-loader-script-src',
      weight: 3,
      matched:
        has(/<script[^>]+src=["'][^"']*\.loader\.js["']/i) ||
        has(/\.loader\.js/i),
      detail: '*.loader.js script reference',
    });

    signals.push({
      name: 'unity-config-keys',
      weight: 2,
      matched:
        has(/dataurl/i) &&
        has(/frameworkurl/i) &&
        (has(/codeurl/i) || has(/wasmcodeurl/i) || has(/wasmurl/i)),
      detail: 'dataUrl+frameworkUrl+codeUrl config keys',
    });

    signals.push({
      name: 'unity-runtime-signatures',
      weight: 2,
      matched:
        has(/unityframework/i) ||
        has(/unitywasm/i) ||
        has(/unity_game|unity game/i) ||
        has(/__unity__/i) ||
        has(/unitywebgl/i),
      detail: 'Unity runtime signatures',
    });

    const buildDir = allNames.some((n) => /(^|\/)build\//.test(n));
    signals.push({
      name: 'build-directory-layout',
      weight: 1,
      matched: buildDir || has(/["']build\//i),
      detail: 'Build/ directory layout',
    });

    const wasmName = allNames.some((n) => /\.wasm(\.br)?$/i.test(n));
    const wasmRef = has(/\.wasm/i);
    signals.push({
      name: 'wasm-artifact',
      weight: 2,
      matched: wasmName || wasmRef,
      detail: '.wasm artifact or reference',
    });

    const dataName = allNames.some((n) => /\.data(\.br)?$/i.test(n));
    const dataRef = has(/\.data/i);
    signals.push({
      name: 'data-artifact',
      weight: 1,
      matched: dataName || dataRef,
      detail: '.data artifact or reference',
    });

    const frameworkName = allNames.some((n) =>
      /\.framework\.js(\.br)?$/i.test(n),
    );
    const frameworkRef = has(/\.framework\.js/i);
    signals.push({
      name: 'framework-artifact',
      weight: 2,
      matched: frameworkName || frameworkRef,
      detail: '.framework.js artifact or reference',
    });

    // Probe-based signal: known build artifacts reachable (HEAD/GET probes)
    const probeHits = probeKeys.filter((k) =>
      /loader\.js$|framework\.js$|\.wasm$|\.data$|\.wasm\.br$|\.data\.br$|\.framework\.js\.br$/.test(
        k,
      ),
    ).length;
    signals.push({
      name: 'probed-build-artifacts',
      weight: 2,
      matched: probeHits >= 2,
      detail: `${probeHits} probed build artifacts`,
    });

    // Explicit machine-readable Unity delivery manifest: a named loader
    // URL plus the data/framework/code config triple, in Unity's own
    // delivery vocabulary. Decisive (not a filename guess) — portals emit
    // it exactly when the payload is a Unity build.
    const hasLoaderDecl =
      has(/unityloaderurl/i) || has(/"loader"\s*:\s*"unity/i);
    const hasConfigTriple =
      has(/dataurl/i) &&
      has(/frameworkurl/i) &&
      (has(/codeurl/i) || has(/wasmcodeurl/i) || has(/wasmurl/i));
    const manifestMatched =
      has(/unityconfigoptions/i) && hasLoaderDecl && hasConfigTriple;
    signals.push({
      name: 'unity-delivery-manifest',
      weight: 5,
      matched: manifestMatched,
      detail: 'explicit Unity delivery manifest (loader URL + config triple)',
    });

    // Content-hashed Unity build layout: multiple long-hex asset names
    // with Unity artifact extensions (Brotli variants included). Hashed
    // names alone prove nothing — but alongside other Unity evidence they
    // confirm the modern hashed-build layout (`962b….wasm.br` et al.).
    const hashedHits = allNames.filter((n) =>
      /(^|\/)[0-9a-f]{16,}\.(js|wasm|data)(\.br)?$/i.test(n),
    );
    const hashedHasBinary = hashedHits.some((n) =>
      /\.(wasm|data)(\.br)?$/i.test(n),
    );
    signals.push({
      name: 'hashed-unity-build',
      weight: 2,
      matched: hashedHits.length >= 2 && hashedHasBinary,
      detail: `${hashedHits.length} content-hashed build assets`,
    });

    const confidence = scoreSignals(signals);
    return {
      engine: 'unity',
      // A conclusive delivery manifest is evidence of a different kind
      // than filename guessing: the delivery layer explicitly declares a
      // Unity payload (loader + full config triple). Floor the confidence
      // so overwhelmingly explicit evidence is never outvoted by absent
      // filename patterns. Anything less still scores purely additively.
      confidence: manifestMatched ? Math.max(confidence, 0.85) : confidence,
      signals,
    };
  }
}
