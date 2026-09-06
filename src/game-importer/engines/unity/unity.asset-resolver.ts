import { Injectable } from '@nestjs/common';
import { UnityBuild } from '../../core/types';
import {
  DiagnosticCode,
  DiagnosticCollector,
  ImportDiagnostic,
} from '../../core/diagnostics';

export interface ResolvedUnityAssets {
  urls: string[];
  build: UnityBuild;
  diagnostics: ImportDiagnostic[];
}

/** Asset reference fields resolved against the loader/document base URL. */
const RESOLVABLE_FIELDS: (keyof UnityBuild)[] = [
  'dataUrl',
  'frameworkUrl',
  'wasmCodeUrl',
  'codeUrl',
  'streamingAssetsUrl',
  'memoryUrl',
  'symbolsUrl',
];

/**
 * Resolves Unity build asset URLs against the loader/document base URL.
 * Only resolves known configuration/path references (dataUrl, frameworkUrl,
 * codeUrl/wasmCodeUrl, streamingAssetsUrl, memoryUrl, symbolsUrl). Only
 * HTTP/HTTPS targets are accepted — anything else (data:, blob:, file:,
 * javascript:, ftp:, …) is refused with an INVALID_REFERENCE diagnostic and
 * never fetched. Never performs blind global string replacement on
 * JS/binaries.
 */
@Injectable()
export class UnityAssetResolver {
  resolve(build: UnityBuild, baseUrl: string): ResolvedUnityAssets {
    const collector = new DiagnosticCollector();
    const urls: string[] = [];
    const resolveOne = (field: string, ref?: string): string | undefined => {
      if (!ref) return undefined;
      const trimmed = ref.trim();
      if (!trimmed) {
        collector.error(
          DiagnosticCode.INVALID_REFERENCE,
          `Empty ${field} reference in Unity build config`,
          { field },
        );
        return undefined;
      }
      // Refuse pseudo-URLs and non-http(s) schemes outright.
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
        if (!/^https?:/i.test(trimmed)) {
          collector.error(
            DiagnosticCode.INVALID_REFERENCE,
            `Refusing non-HTTP(S) ${field} reference`,
            { field },
          );
          return undefined;
        }
      }
      let abs: URL;
      try {
        abs = new URL(trimmed, baseUrl);
      } catch {
        collector.error(
          DiagnosticCode.INVALID_REFERENCE,
          `Unresolvable ${field} reference in Unity build config`,
          { field },
        );
        return undefined;
      }
      if (!['http:', 'https:'].includes(abs.protocol)) {
        collector.error(
          DiagnosticCode.INVALID_REFERENCE,
          `Refusing non-HTTP(S) ${field} target`,
          { field },
        );
        return undefined;
      }
      return abs.toString();
    };

    const resolved: UnityBuild = { loaderUrl: build.loaderUrl };
    for (const f of RESOLVABLE_FIELDS) {
      const v = (build as unknown as Record<string, string | undefined>)[f];
      if (!v) continue;
      const abs = resolveOne(f, v);
      if (abs) {
        (resolved as unknown as Record<string, string>)[f] = abs;
        // streamingAssets is a prefix/dir — include marker but not enumerable file
        if (f !== 'streamingAssetsUrl') {
          urls.push(abs);
          collector.info(
            f === 'dataUrl'
              ? DiagnosticCode.UNITY_DATA_RESOLVED
              : f === 'frameworkUrl'
                ? DiagnosticCode.UNITY_FRAMEWORK_RESOLVED
                : f === 'wasmCodeUrl' || f === 'codeUrl'
                  ? DiagnosticCode.UNITY_WASM_RESOLVED
                  : DiagnosticCode.ASSET_DOWNLOADED,
            `Resolved Unity ${f}`,
            { field: f, url: abs },
          );
        }
      }
    }
    // Dedupe preserving order
    const seen = new Set<string>();
    const deduped = urls.filter((u) =>
      seen.has(u) ? false : (seen.add(u), true),
    );
    return { urls: deduped, build: resolved, diagnostics: collector.all() };
  }

  /**
   * Safe, narrowly-scoped config rewrite: given loader JS text and a mapping
   * of old->new for KNOWN asset keys only, rewrite those values. Refuses to
   * do blind global replacement: only quoted values of known keys are touched.
   */
  rewriteKnownConfigRefs(
    loaderJs: string,
    mapping: Record<string, string>,
  ): string {
    let out = loaderJs;
    const allowedKeys = new Set([
      'dataUrl',
      'frameworkUrl',
      'codeUrl',
      'wasmCodeUrl',
      'wasmUrl',
      'streamingAssetsUrl',
      'memoryUrl',
      'symbolsUrl',
    ]);
    for (const [key, newVal] of Object.entries(mapping)) {
      if (!allowedKeys.has(key)) continue;
      // Support both object-literal (`key: "v"`) and assignment (`key = "v"`).
      const re = new RegExp(`(["']?${key}["']?\\s*[:=]\\s*["'])([^"']+)(["'])`);
      out = out.replace(re, `$1${newVal}$3`);
    }
    return out;
  }
}
