import { Injectable } from '@nestjs/common';
import { UnityBuild } from '../../core/types';
import {
  DiagnosticCode,
  DiagnosticCollector,
  ImportDiagnostic,
  ImportError,
} from '../../core/diagnostics';
import { SourcePolicyService } from '../../core/source-policy';
import {
  UnityLoaderParser,
  classifyUnityArtifact,
} from './unity.loader-parser';
import { findStreamingAssetsHint } from './unity.streaming-assets';
import { UnityBuildRoleUrls } from '../../sources/source.interface';

/** Where the winning Unity build config was discovered (generic stages). */
export type UnityConfigSource =
  'loader' | 'caller' | 'external' | 'adapter-hints';

export interface DiscoveredUnityConfig {
  /** Build URLs WITHOUT loaderUrl (the importer sets it from the fetch). */
  build: UnityBuild;
  raw: Record<string, string>;
  source: UnityConfigSource;
  /** Base URL against which relative refs must be resolved. */
  configBaseUrl: string;
  diagnostics: ImportDiagnostic[];
}

export interface ConfigDiscoveryInput {
  /** Downloaded loader JS text (never executed). */
  loaderJs: string;
  /** Final loader URL (fetch base for loader-relative refs). */
  loaderUrl: string;
  /** Entry/game document HTML (never executed). */
  entryHtml: string;
  /** Final entry URL (fetch base for caller-relative refs). */
  entryUrl: string;
  /** Absolute http(s) asset hints from the source adapter (generic). */
  adapterAssetUrls?: string[];
  /**
   * Role-labeled Unity build URLs from the adapter delivery config
   * (explicit semantics: no extension guessing needed). Explicit
   * page-embedded values always win; roles only fill absence and seed
   * synthesis. Never carries platform-specific structures.
   */
  adapterBuild?: UnityBuildRoleUrls;
  /**
   * Policy/SSRF-guarded text fetcher for explicit external script refs,
   * provided by the importer (owns downloader + limits).
   */
  fetchExternalScript: (url: string) => Promise<string>;
  /** Max external scripts to inspect (default 5). */
  maxExternalScripts?: number;
}

const MAX_ADAPTER_HINTS = 200;

/**
 * Multi-source Unity build-config discovery (M3.1, engine-generic).
 *
 * Priority:
 *   A. Explicit config literals in the loader text itself.
 *   B. Static `createUnityInstance(...)` config in the caller document
 *      (inline scripts, then explicitly referenced external scripts).
 *   B3. Role-labeled adapter build URLs (explicit delivery semantics —
 *      content-hashed builds included, no extension guessing).
 *   C. Explicit adapter asset URLs mapped by artifact kind (fills gaps).
 *   D. Fail closed with UNITY_CONFIG_NOT_FOUND.
 *
 * No platform concepts, no filename hardcoding, no code execution.
 */
@Injectable()
export class UnityConfigDiscovery {
  constructor(
    private readonly parser: UnityLoaderParser,
    private readonly policy: SourcePolicyService,
  ) {}

  async discover(input: ConfigDiscoveryInput): Promise<DiscoveredUnityConfig> {
    const collector = new DiagnosticCollector();
    collector.info(
      DiagnosticCode.UNITY_CONFIG_DISCOVERY_STARTED,
      'Unity config discovery started (loader, caller, adapter hints)',
    );

    // A. Explicit loader configuration.
    const fromLoader = this.tryLoader(input.loaderJs, collector);
    if (fromLoader) {
      const merged = this.fillFromAdapterHints(
        fromLoader,
        input.adapterAssetUrls ?? [],
        collector,
        input.adapterBuild,
      );
      return {
        build: merged,
        raw: rawOf(merged),
        source: 'loader',
        configBaseUrl: input.loaderUrl,
        diagnostics: collector.all(),
      };
    }

    // B. Caller document: inline scripts, then joined fallback.
    const inlineScripts = this.parser.extractInlineScripts(input.entryHtml);
    const caller = this.tryCallerScripts(inlineScripts, collector);
    if (caller) {
      collector.info(
        DiagnosticCode.UNITY_CONFIG_FROM_CALLER,
        caller.viaVariable
          ? 'Unity config resolved from caller document variable'
          : 'Unity config resolved from caller document',
        {
          ...(caller.viaVariable ? { variable: caller.viaVariable } : {}),
        },
      );
      if (caller.viaVariable) {
        collector.info(
          DiagnosticCode.UNITY_CONFIG_VARIABLE_RESOLVED,
          'Unity config variable resolved statically (no execution)',
          { variable: caller.viaVariable },
        );
      }
      const merged = this.fillFromAdapterHints(
        toBuild(caller.raw),
        input.adapterAssetUrls ?? [],
        collector,
        input.adapterBuild,
      );
      return {
        build: merged,
        raw: caller.raw,
        source: 'caller',
        configBaseUrl: input.entryUrl,
        diagnostics: collector.all(),
      };
    }

    // B2. Explicitly referenced external scripts (bounded, policy-gated).
    const external = await this.tryExternalScripts(input, collector);
    if (external) {
      const merged = this.fillFromAdapterHints(
        toBuild(external.raw),
        input.adapterAssetUrls ?? [],
        collector,
        input.adapterBuild,
      );
      return {
        build: merged,
        raw: external.raw,
        source: 'external',
        configBaseUrl: external.scriptUrl,
        diagnostics: collector.all(),
      };
    }

    // B3. Role-labeled adapter build (explicit delivery semantics).
    const fromRoles = this.buildFromRoles(input.adapterBuild, collector);
    if (fromRoles) {
      const merged = this.fillFromAdapterHints(
        fromRoles,
        input.adapterAssetUrls ?? [],
        collector,
        input.adapterBuild,
      );
      return {
        build: merged,
        raw: rawOf(merged),
        source: 'adapter-hints',
        configBaseUrl: input.loaderUrl,
        diagnostics: collector.all(),
      };
    }

    // C. Adapter hints alone (no explicit config anywhere).
    const synthesized = this.synthesizeFromAdapterHints(
      input.adapterAssetUrls ?? [],
      collector,
      input.adapterBuild,
    );
    if (synthesized) {
      return {
        build: synthesized,
        raw: rawOf(synthesized),
        source: 'adapter-hints',
        configBaseUrl: input.loaderUrl,
        diagnostics: collector.all(),
      };
    }

    // D. Fail closed with a structured diagnostic.
    collector.error(
      DiagnosticCode.UNITY_CONFIG_NOT_FOUND,
      'No Unity build configuration found (expected dataUrl/frameworkUrl/codeUrl)',
    );
    throw new ImportError(
      DiagnosticCode.UNITY_CONFIG_NOT_FOUND,
      'No Unity build configuration found in loader (expected dataUrl/frameworkUrl/codeUrl)',
      collector.all(),
    );
  }

  private tryLoader(
    loaderJs: string,
    collector: DiagnosticCollector,
  ): UnityBuild | null {
    let detailed: ReturnType<UnityLoaderParser['parseDetailed']>;
    try {
      detailed = this.parser.parseDetailed(loaderJs);
    } catch (err) {
      // parseDetailed throws ImportError(NOT_FOUND) when valueless; forward
      // its diagnostics and continue down the chain.
      if (err instanceof ImportError) {
        for (const d of err.diagnostics)
          collector.add(d.level, d.code, d.message, d.details);
        return null;
      }
      throw err;
    }
    for (const d of detailed.diagnostics) {
      collector.add(d.level, d.code, d.message, d.details);
    }
    collector.info(
      DiagnosticCode.UNITY_CONFIG_FROM_LOADER,
      'Unity config resolved from loader text',
    );
    return detailed.parsed.build;
  }

  private tryCallerScripts(
    inlineScripts: string[],
    collector: DiagnosticCollector,
  ): { raw: Record<string, string>; viaVariable: string | null } | null {
    let callsSeen = false;
    for (const script of inlineScripts) {
      if (this.parser.findCreateInstanceCalls(script).length > 0) {
        callsSeen = true;
      }
      const resolved = this.parser.resolveCallerConfig(script);
      if (resolved) return resolved;
    }
    // Fallback: declaration and call may live in different blocks.
    if (inlineScripts.length > 1) {
      const joined = inlineScripts.join('\n');
      if (this.parser.findCreateInstanceCalls(joined).length > 0) {
        callsSeen = true;
      }
      const resolved = this.parser.resolveCallerConfig(joined);
      if (resolved) {
        collector.info(
          DiagnosticCode.UNITY_CONFIG_VARIABLE_RESOLVED,
          'Unity config variable resolved across caller script blocks',
          { variable: resolved.viaVariable ?? undefined },
        );
        return resolved;
      }
    }
    if (callsSeen) {
      collector.info(
        DiagnosticCode.UNITY_CREATE_INSTANCE_FOUND,
        'createUnityInstance call found in caller document without resolvable config values',
      );
    }
    return null;
  }

  private async tryExternalScripts(
    input: ConfigDiscoveryInput,
    collector: DiagnosticCollector,
  ): Promise<{
    raw: Record<string, string>;
    viaVariable: string | null;
    scriptUrl: string;
  } | null> {
    const cap = input.maxExternalScripts ?? 5;
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const ref of this.parser.extractExternalScriptUrls(input.entryHtml)) {
      let abs: URL;
      try {
        abs = new URL(ref, input.entryUrl);
      } catch {
        continue;
      }
      if (!['http:', 'https:'].includes(abs.protocol)) continue;
      const href = abs.toString();
      if (href === input.loaderUrl || seen.has(href)) continue;
      seen.add(href);
      // SourcePolicy gate per candidate: unauthorized config sources are
      // skipped (warning), never fetched.
      try {
        this.policy.assertAllowed(href);
      } catch (err) {
        collector.warning(
          DiagnosticCode.EXTERNAL_REFERENCE,
          'Skipping external script outside the authorized source policy',
          { reason: (err as Error).message },
        );
        continue;
      }
      candidates.push(href);
      if (candidates.length >= cap) break;
    }
    for (const scriptUrl of candidates) {
      let text: string;
      try {
        text = await input.fetchExternalScript(scriptUrl);
      } catch (err) {
        collector.warning(
          DiagnosticCode.NETWORK_FAILURE,
          'External config script fetch failed; continuing discovery',
          { reason: (err as Error).message },
        );
        continue;
      }
      const resolved = this.parser.resolveCallerConfig(text);
      const bare = resolved ? null : this.parser.extractBareConfig(text);
      const hit =
        resolved ??
        (bare
          ? { raw: bare, viaVariable: null as string | null, callIndex: -1 }
          : null);
      if (hit) {
        collector.info(
          DiagnosticCode.UNITY_CONFIG_FROM_EXTERNAL_RESOURCE,
          'Unity config resolved from explicitly referenced external script',
          {
            ...(hit.viaVariable ? { variable: hit.viaVariable } : {}),
          },
        );
        if (hit.viaVariable) {
          collector.info(
            DiagnosticCode.UNITY_CONFIG_VARIABLE_RESOLVED,
            'Unity config variable resolved statically (no execution)',
            { variable: hit.viaVariable },
          );
        }
        return { ...hit, scriptUrl };
      }
    }
    return null;
  }

  /**
   * Build a config purely from role-labeled adapter URLs (explicit
   * delivery semantics — works for content-hashed builds whose filenames
   * carry no conventional extensions). Requires at least one downloadable
   * asset role (data/framework/wasm family); a loader URL alone is not a
   * usable build. Relative values are kept raw for base-resolution by the
   * asset resolver; non-http(s) absolute values are refused.
   */
  private buildFromRoles(
    roles: UnityBuildRoleUrls | undefined,
    collector: DiagnosticCollector,
  ): UnityBuild | null {
    if (!roles) return null;
    const build: UnityBuild = { loaderUrl: '' };
    const filled = this.applyRoles(build, roles, collector, 'labeled');
    const usable =
      filled.includes('dataUrl') ||
      filled.includes('frameworkUrl') ||
      filled.includes('codeUrl');
    if (!usable) return null;
    collector.info(
      DiagnosticCode.UNITY_CONFIG_FROM_ADAPTER_HINTS,
      'Unity config resolved from role-labeled adapter build URLs',
      { fields: filled },
    );
    return build;
  }

  /**
   * Copy role-labeled URLs into a build. Explicit values always win —
   * only absent fields are filled. Returns the filled field names.
   */
  private applyRoles(
    build: UnityBuild,
    roles: UnityBuildRoleUrls | undefined,
    collector: DiagnosticCollector,
    how: 'labeled' | 'gap-fill',
  ): string[] {
    if (!roles) return [];
    const filled: string[] = [];
    const take = (
      field:
        | 'loaderUrl'
        | 'dataUrl'
        | 'frameworkUrl'
        | 'codeUrl'
        | 'streamingAssetsUrl'
        | 'memoryUrl'
        | 'symbolsUrl',
    ): void => {
      const current = (build as unknown as Record<string, string>)[field];
      if (current) return;
      if (field === 'codeUrl' && build.wasmCodeUrl) return;
      const raw = roles[field];
      if (typeof raw !== 'string') return;
      const v = raw.trim();
      if (!v) return;
      // Absolute values must be http(s); relative refs are kept raw for
      // base-resolution downstream.
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) {
        if (!/^https?:/i.test(v)) return;
      }
      (build as unknown as Record<string, string>)[field] = v;
      filled.push(field);
      collector.info(
        DiagnosticCode.UNITY_ASSET_URL_RESOLVED,
        `Unity ${field} resolved from role-${how} adapter build URL`,
        { field },
      );
    };
    take('loaderUrl');
    take('dataUrl');
    take('frameworkUrl');
    take('codeUrl');
    take('streamingAssetsUrl');
    take('memoryUrl');
    take('symbolsUrl');
    return filled;
  }

  /**
   * Fill config gaps from explicit adapter asset URLs by artifact kind.
   * Explicit (loader/caller) values always win; role-labeled URLs win
   * over extension guessing; hints only fill absence.
   */
  private fillFromAdapterHints(
    build: UnityBuild,
    adapterAssetUrls: string[],
    collector: DiagnosticCollector,
    roles?: UnityBuildRoleUrls,
  ): UnityBuild {
    const filled: string[] = [];
    const filledByRoles = this.applyRoles(build, roles, collector, 'labeled');
    filled.push(...filledByRoles);
    const take = (
      field: 'dataUrl' | 'frameworkUrl' | 'codeUrl',
      kind: 'data' | 'framework' | 'wasm',
    ): void => {
      if (build[field]) return;
      const hit = firstHintOfKind(adapterAssetUrls, kind);
      if (hit) {
        (build as unknown as Record<string, string>)[field] = hit;
        filled.push(field);
        collector.info(
          DiagnosticCode.UNITY_ASSET_URL_RESOLVED,
          `Unity ${field} filled from adapter asset hint`,
          { field },
        );
      }
    };
    take('dataUrl', 'data');
    take('frameworkUrl', 'framework');
    if (!build.codeUrl && !build.wasmCodeUrl) {
      const hit = firstHintOfKind(adapterAssetUrls, 'wasm');
      if (hit) {
        build.codeUrl = hit;
        filled.push('codeUrl');
        collector.info(
          DiagnosticCode.UNITY_ASSET_URL_RESOLVED,
          'Unity codeUrl filled from adapter asset hint',
          { field: 'codeUrl' },
        );
      }
    }
    // StreamingAssets is a prefix signal, not a downloadable file: derive
    // it from any adapter hint at/under the StreamingAssets path (portal
    // delivery configs expose the directory URL itself). Explicit values
    // always win; hints only fill absence.
    if (!build.streamingAssetsUrl) {
      const hint = findStreamingAssetsHint(adapterAssetUrls);
      if (hint) {
        build.streamingAssetsUrl = hint;
        filled.push('streamingAssetsUrl');
        collector.info(
          DiagnosticCode.UNITY_ASSET_URL_RESOLVED,
          'Unity streamingAssetsUrl filled from adapter asset hint',
          { field: 'streamingAssetsUrl' },
        );
      }
    }
    if (filled.length > 0) {
      collector.info(
        DiagnosticCode.UNITY_CONFIG_FROM_ADAPTER_HINTS,
        'Unity config gaps filled from adapter asset hints',
        { fields: filled },
      );
    }
    return build;
  }

  /** Synthesize a whole build purely from adapter hints (step C). */
  private synthesizeFromAdapterHints(
    adapterAssetUrls: string[],
    collector: DiagnosticCollector,
    roles?: UnityBuildRoleUrls,
  ): UnityBuild | null {
    const build: UnityBuild = { loaderUrl: '' };
    let found = false;
    const seed = this.applyRoles(build, roles, collector, 'labeled');
    if (
      seed.includes('dataUrl') ||
      seed.includes('frameworkUrl') ||
      seed.includes('codeUrl')
    ) {
      found = true;
    }
    const take = (
      field: 'loaderUrl' | 'dataUrl' | 'frameworkUrl' | 'codeUrl',
      kind: 'loader' | 'framework' | 'wasm' | 'data',
    ): void => {
      // Role-seeded values always win over extension guessing.
      if ((build as unknown as Record<string, string>)[field]) return;
      const hit = firstHintOfKind(adapterAssetUrls, kind);
      if (hit) {
        (build as unknown as Record<string, string>)[field] = hit;
        found = true;
        collector.info(
          DiagnosticCode.UNITY_ASSET_URL_RESOLVED,
          `Unity ${field} synthesized from adapter asset hint`,
          { field },
        );
      }
    };
    take('loaderUrl', 'loader');
    take('dataUrl', 'data');
    take('frameworkUrl', 'framework');
    take('codeUrl', 'wasm');
    if (!found) return null;
    // A loader URL alone is not a usable build (nothing to download).
    if (!build.dataUrl && !build.frameworkUrl && !build.codeUrl) return null;
    // Carry the StreamingAssets prefix signal when hints expose it (a
    // signal only — never downloaded itself).
    const streamingHint = findStreamingAssetsHint(adapterAssetUrls);
    if (streamingHint && !build.streamingAssetsUrl) {
      build.streamingAssetsUrl = streamingHint;
      collector.info(
        DiagnosticCode.UNITY_ASSET_URL_RESOLVED,
        'Unity streamingAssetsUrl synthesized from adapter asset hint',
        { field: 'streamingAssetsUrl' },
      );
    }
    collector.info(
      DiagnosticCode.UNITY_CONFIG_FROM_ADAPTER_HINTS,
      'Unity config synthesized from adapter asset hints',
    );
    return build;
  }
}

function firstHintOfKind(
  urls: string[],
  kind: 'loader' | 'framework' | 'wasm' | 'data',
): string | undefined {
  let checked = 0;
  for (const u of urls) {
    if (checked++ >= MAX_ADAPTER_HINTS) break;
    if (classifyUnityArtifact(u) === kind) return u;
  }
  return undefined;
}

function toBuild(raw: Record<string, string>): UnityBuild {
  return {
    loaderUrl: raw['loaderUrl'] ?? '',
    ...(raw['dataUrl'] ? { dataUrl: raw['dataUrl'] } : {}),
    ...(raw['frameworkUrl'] ? { frameworkUrl: raw['frameworkUrl'] } : {}),
    ...(raw['wasmCodeUrl']
      ? { wasmCodeUrl: raw['wasmCodeUrl'] }
      : raw['codeUrl']
        ? { codeUrl: raw['codeUrl'] }
        : raw['wasmUrl']
          ? { codeUrl: raw['wasmUrl'] }
          : {}),
    ...(raw['streamingAssetsUrl']
      ? { streamingAssetsUrl: raw['streamingAssetsUrl'] }
      : {}),
    ...(raw['memoryUrl'] ? { memoryUrl: raw['memoryUrl'] } : {}),
    ...(raw['symbolsUrl'] ? { symbolsUrl: raw['symbolsUrl'] } : {}),
  };
}

function rawOf(build: UnityBuild): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(build)) {
    if (typeof v === 'string' && v) raw[k] = v;
  }
  return raw;
}
