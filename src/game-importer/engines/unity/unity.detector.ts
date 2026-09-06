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
 * build layouts (no hardcoded partner-specific names like y8.data).
 */
@Injectable()
export class UnityDetector {
  async detect(context: DetectionContext): Promise<DetectionResult> {
    const signals: DetectionSignal[] = [];
    const html = (context.html ?? '').slice(0, 500_000);
    const names = (context.fileNames ?? []).map((n) => n.toLowerCase());
    const probeKeys = Object.keys(context.probes ?? {}).map((k) =>
      k.toLowerCase(),
    );
    const allNames = [...names, ...probeKeys];

    const has = (re: RegExp) => re.test(html);

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

    const wasmName = allNames.some((n) => n.endsWith('.wasm'));
    const wasmRef = has(/\.wasm/i);
    signals.push({
      name: 'wasm-artifact',
      weight: 2,
      matched: wasmName || wasmRef,
      detail: '.wasm artifact or reference',
    });

    const dataName = allNames.some((n) => n.endsWith('.data'));
    const dataRef = has(/\.data/i);
    signals.push({
      name: 'data-artifact',
      weight: 1,
      matched: dataName || dataRef,
      detail: '.data artifact or reference',
    });

    const frameworkName = allNames.some((n) => n.endsWith('.framework.js'));
    const frameworkRef = has(/\.framework\.js/i);
    signals.push({
      name: 'framework-artifact',
      weight: 2,
      matched: frameworkName || frameworkRef,
      detail: '.framework.js artifact or reference',
    });

    // Probe-based signal: known build artifacts reachable (HEAD/GET probes)
    const probeHits = probeKeys.filter((k) =>
      /loader\.js$|framework\.js$|\.wasm$|\.data$/.test(k),
    ).length;
    signals.push({
      name: 'probed-build-artifacts',
      weight: 2,
      matched: probeHits >= 2,
      detail: `${probeHits} probed build artifacts`,
    });

    const confidence = scoreSignals(signals);
    return { engine: 'unity', confidence, signals };
  }
}
