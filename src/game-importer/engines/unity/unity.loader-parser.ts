import { Injectable } from '@nestjs/common';
import { UnityBuild } from '../../core/types';
import {
  DiagnosticCode,
  DiagnosticCollector,
  ImportError,
} from '../../core/diagnostics';

export interface ParsedUnityConfig {
  build: UnityBuild;
  raw: Record<string, string>;
}

/** Known Unity WebGL config keys (engine knowledge, not platform-specific). */
const CONFIG_KEYS = [
  'dataUrl',
  'frameworkUrl',
  'codeUrl',
  'wasmCodeUrl',
  'wasmUrl',
  'streamingAssetsUrl',
  'memoryUrl',
  'symbolsUrl',
  'loaderUrl',
];

/**
 * A statically discovered `createUnityInstance(...)` call site.
 * Only the SECOND argument is inspected; it is either an inline object
 * literal or a variable reference resolved textually. Anything else is
 * reported as `unknown` and never executed.
 */
export interface CreateInstanceCall {
  kind: 'inline-object' | 'variable' | 'unknown';
  /** Balanced `{...}` source when kind === 'inline-object'. */
  objectText?: string;
  /** Identifier when kind === 'variable'. */
  varName?: string;
  /** Character offset of the call (deterministic ordering). */
  index: number;
}

export interface CallerConfigResult {
  raw: Record<string, string>;
  /** Variable name when resolved through a variable, else null. */
  viaVariable: string | null;
  /** Character offset of the winning call site. */
  callIndex: number;
}

const MAX_SCAN_CHARS = 1_000_000;
const MAX_CALL_SITES = 5;
const MAX_INLINE_SCRIPT_CHARS = 1_000_000;
/**
 * Unity loader parser: dynamically identifies build configuration from loader
 * JS / inline config WITHOUT hardcoded partner filenames.
 *
 * Strategies (in order):
 *  1. JSON-ish config object containing dataUrl/frameworkUrl/codeUrl keys
 *     (quoted or unquoted, single/double quotes).
 *  2. createUnityInstance(canvas, {...}) second-argument object literal.
 *  3. <script src="*.loader.js"> discovery + relative asset inference is left
 *     to the asset resolver.
 */
@Injectable()
export class UnityLoaderParser {
  parse(loaderJs: string): ParsedUnityConfig {
    return this.parseDetailed(loaderJs).parsed;
  }

  /**
   * Static-only parse (never executes downloaded JS). Returns the parsed
   * build plus the diagnostics collected along the way. Throws an
   * {@link ImportError} with code `UNITY_CONFIG_NOT_FOUND` when no known
   * configuration keys can be resolved safely.
   *
   * IMPORTANT: only `key: "value"` literals count as resolved values.
   * Property reads such as `m.dataUrl` merely signal that the loader
   * EXPECTS an external config (reported via `expectsExternalConfig`);
   * they are never treated as proof that a URL is known.
   */
  parseDetailed(loaderJs: string): {
    parsed: ParsedUnityConfig;
    diagnostics: ReturnType<DiagnosticCollector['all']>;
    expectsExternalConfig: boolean;
  } {
    const collector = new DiagnosticCollector();
    const text = loaderJs.slice(0, MAX_SCAN_CHARS);
    const raw = extractKnownKeyValues(text);

    // Fallback: find any *.loader.js-adjacent quoted asset URLs? No — only
    // accept known config keys to avoid blind rewriting/scraping.
    const dataUrl = raw['dataUrl'];
    const frameworkUrl = raw['frameworkUrl'];
    const wasmCodeUrl = raw['wasmCodeUrl'] ?? raw['codeUrl'] ?? raw['wasmUrl'];
    const streamingAssetsUrl = raw['streamingAssetsUrl'];
    const expectsExternalConfig = detectExpectedConfig(text);

    if (!dataUrl && !frameworkUrl && !wasmCodeUrl) {
      if (expectsExternalConfig) {
        collector.info(
          DiagnosticCode.UNITY_CREATE_INSTANCE_FOUND,
          'Loader expects external Unity config (createUnityInstance / config property reads detected); no literal URLs present',
        );
      }
      collector.error(
        DiagnosticCode.UNITY_CONFIG_NOT_FOUND,
        'No Unity build configuration found in loader (expected dataUrl/frameworkUrl/codeUrl)',
        { keysFound: Object.keys(raw) },
      );
      throw new ImportError(
        DiagnosticCode.UNITY_CONFIG_NOT_FOUND,
        'No Unity build configuration found in loader (expected dataUrl/frameworkUrl/codeUrl)',
        collector.all(),
      );
    }
    collector.info(
      DiagnosticCode.UNITY_BUILD_CONFIG_FOUND,
      'Unity build configuration identified from loader',
      {
        hasDataUrl: Boolean(dataUrl),
        hasFrameworkUrl: Boolean(frameworkUrl),
        hasWasmUrl: Boolean(wasmCodeUrl),
        hasStreamingAssets: Boolean(streamingAssetsUrl),
      },
    );

    const build: UnityBuild = {
      loaderUrl: raw['loaderUrl'] ?? '',
      ...(dataUrl ? { dataUrl } : {}),
      ...(frameworkUrl ? { frameworkUrl } : {}),
      ...(wasmCodeUrl ? { wasmCodeUrl } : {}),
      ...(raw['codeUrl'] ? { codeUrl: raw['codeUrl'] } : {}),
      ...(streamingAssetsUrl ? { streamingAssetsUrl } : {}),
      ...(raw['memoryUrl'] ? { memoryUrl: raw['memoryUrl'] } : {}),
      ...(raw['symbolsUrl'] ? { symbolsUrl: raw['symbolsUrl'] } : {}),
    };
    return {
      parsed: { build, raw },
      diagnostics: collector.all(),
      expectsExternalConfig,
    };
  }

  /** Extract loader script URLs from HTML (relative or absolute). */
  findLoaderScriptUrls(html: string): string[] {
    const out: string[] = [];
    const re = /<script[^>]+src=["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      out.push(m[1]);
    }
    return out;
  }

  /**
   * Extract inline (src-less) executable script bodies from HTML.
   * `application/json` / `application/ld+json` data blocks are skipped:
   * they are data, not caller code (platform adapters handle delivery
   * metadata separately). Never executes anything.
   */
  extractInlineScripts(html: string): string[] {
    const out: string[] = [];
    let total = 0;
    const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html.slice(0, MAX_SCAN_CHARS))) !== null) {
      const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
      if (/type\s*=\s*["']application\/(json|ld\+json)["']/i.test(openTag)) {
        continue;
      }
      const body = (m[1] ?? '').trim();
      if (!body) continue;
      total += body.length;
      if (total > MAX_INLINE_SCRIPT_CHARS) break;
      out.push(body);
    }
    return out;
  }

  /** Extract external script URLs (src) from HTML in document order. */
  extractExternalScriptUrls(html: string, max = 50): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const re = /<script[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html.slice(0, MAX_SCAN_CHARS))) !== null) {
      const src = (m[1] ?? '').trim();
      if (!src || seen.has(src)) continue;
      seen.add(src);
      out.push(src);
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * Statically locate `createUnityInstance(...)` call sites and classify
   * the second (config) argument. Balanced scanning is quote/comment
   * aware; function DECLARATIONS (`function createUnityInstance(`) and
   * matches inside comments are excluded. Anything that cannot be
   * classified safely is `unknown`.
   */
  findCreateInstanceCalls(
    js: string,
    maxCalls = MAX_CALL_SITES,
  ): CreateInstanceCall[] {
    const out: CreateInstanceCall[] = [];
    const text = js.slice(0, MAX_SCAN_CHARS);
    const masked = maskComments(text);
    const callRe = /createUnityInstance\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(masked)) !== null) {
      if (out.length >= maxCalls) break;
      // Exclude function declarations: `function createUnityInstance(`,
      // including `export [default] [async] function` prefixes.
      const before = masked.slice(Math.max(0, m.index - 32), m.index);
      if (/(?:^|[^\w$])function\s*$/.test(before)) continue;
      const argsStart = m.index + m[0].length;
      const args = splitTopLevelArgs(masked, argsStart);
      if (!args) {
        out.push({ kind: 'unknown', index: m.index });
        continue;
      }
      const second = (args[1] ?? '').trim();
      if (!second) {
        out.push({ kind: 'unknown', index: m.index });
        continue;
      }
      if (second.startsWith('{')) {
        const obj = extractBalanced(second, 0, '{', '}');
        out.push(
          obj
            ? { kind: 'inline-object', objectText: obj, index: m.index }
            : { kind: 'unknown', index: m.index },
        );
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(second)) {
        out.push({ kind: 'variable', varName: second, index: m.index });
        continue;
      }
      out.push({ kind: 'unknown', index: m.index });
    }
    return out;
  }

  /**
   * Extract known Unity config keys with quoted-string values from an
   * object-literal source fragment. Unquoted / computed / spread values
   * are ignored (never guessed).
   */
  parseConfigObject(objectText: string): Record<string, string> {
    return extractKnownKeyValues(objectText.slice(0, MAX_SCAN_CHARS));
  }

  /**
   * Resolve `var|let|const NAME = {...}` textually (last declaration wins,
   * mirroring sequential execution order) and extract known keys from the
   * object literal. Returns null when nothing safe resolves. Deliberately
   * limited: no expression evaluation, no function calls, no imports.
   */
  resolveConfigVariable(
    js: string,
    varName: string,
  ): Record<string, string> | null {
    if (!/^[A-Za-z_$][\w$]*$/.test(varName)) return null;
    const text = maskComments(js.slice(0, MAX_SCAN_CHARS));
    const declRe = new RegExp(
      `(?:var|let|const)\\s+${escapeRegExp(varName)}\\s*=\\s*\\{`,
      'g',
    );
    let m: RegExpExecArray | null;
    let last: { raw: Record<string, string> } | null = null;
    while ((m = declRe.exec(text)) !== null) {
      const braceIndex = m[0].lastIndexOf('{');
      const obj = extractBalanced(
        text.slice(m.index + braceIndex),
        0,
        '{',
        '}',
      );
      if (!obj) continue;
      const raw = extractKnownKeyValues(obj);
      if (Object.keys(raw).length > 0) last = { raw };
    }
    return last?.raw ?? null;
  }

  /**
   * Extract known Unity config keys from an explicitly referenced external
   * resource (e.g. `config.js`) WITHOUT requiring a createUnityInstance
   * call site — the explicit `<script src>` reference in the game document
   * is itself the anchor. Returns null unless at least one asset URL
   * (data/framework/wasm family) resolves. Static only, never executed.
   */
  extractBareConfig(text: string): Record<string, string> | null {
    const raw = extractKnownKeyValues(text.slice(0, MAX_SCAN_CHARS));
    return hasAssetUrl(raw) ? raw : null;
  }

  /**
   * Rewrite known Unity config/path references inside inline `<script>`
   * bodies to local package paths (e.g. remote `dataUrl` → `Build/x.data`).
   * Only quoted values of KNOWN keys are touched; JSON data blocks are
   * skipped; `src` attributes are never touched here. This is the narrow,
   * safe rewrite that makes a packaged page runnable offline.
   */
  rewriteInlineConfigRefs(
    html: string,
    mapping: Record<string, string>,
  ): string {
    const allowed = new Set(CONFIG_KEYS);
    const entries = Object.entries(mapping).filter(
      ([k, v]) => allowed.has(k) && v,
    );
    if (entries.length === 0) return html;
    return html.replace(
      /<script(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script\s*>/gi,
      (full, attrs: string, body: string) => {
        if (/type\s*=\s*["']application\/(json|ld\+json)["']/i.test(attrs)) {
          return full;
        }
        let out: string = body;
        for (const [key, newVal] of entries) {
          const re = new RegExp(
            `(["']?${key}["']?\\s*[:=]\\s*["'])([^"']+)(["'])`,
          );
          out = out.replace(re, `$1${newVal}$3`);
        }
        return `<script${attrs}>${out}</script>`;
      },
    );
  }

  /**
   * Resolve caller-supplied Unity config from JavaScript source (typically
   * inline `<script>` bodies of the game document). Tries, in order:
   * inline object literals, then same-text variable resolution. Returns
   * the first call site yielding at least one asset URL (data/framework/
   * wasm family). Never executes code.
   */
  resolveCallerConfig(js: string): CallerConfigResult | null {
    // Scan comment-masked text so commented-out calls/configs never count.
    const text = maskComments(js.slice(0, MAX_SCAN_CHARS));
    for (const call of this.findCreateInstanceCalls(text)) {
      if (call.kind === 'inline-object' && call.objectText) {
        const raw = this.parseConfigObject(call.objectText);
        if (hasAssetUrl(raw)) {
          return { raw, viaVariable: null, callIndex: call.index };
        }
      } else if (call.kind === 'variable' && call.varName) {
        const raw = this.resolveConfigVariable(text, call.varName);
        if (raw && hasAssetUrl(raw)) {
          return { raw, viaVariable: call.varName, callIndex: call.index };
        }
      }
    }
    return null;
  }
}

/** Asset-URL-bearing keys: at least one must resolve for a usable config. */
function hasAssetUrl(raw: Record<string, string>): boolean {
  return Boolean(
    raw['dataUrl'] ??
    raw['frameworkUrl'] ??
    raw['codeUrl'] ??
    raw['wasmCodeUrl'] ??
    raw['wasmUrl'],
  );
}

/** Unity build artifact kinds recognized from URL pathnames (no filenames). */
export type UnityArtifactKind = 'loader' | 'framework' | 'wasm' | 'data';

/**
 * Classify an absolute asset URL by Unity artifact kind from its pathname
 * extension pattern only. Never matches on full filenames or hosts.
 */
export function classifyUnityArtifact(
  rawUrl: string,
): UnityArtifactKind | null {
  let pathname: string;
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\.loader\.js$/.test(pathname)) return 'loader';
  if (/\.framework\.js(\.br)?$/.test(pathname)) return 'framework';
  if (/\.wasm(\.br)?$/.test(pathname)) return 'wasm';
  if (/\.data(\.br)?$/.test(pathname)) return 'data';
  return null;
}

/**
 * Find the first absolute http(s) loader-bundle URL in adapter asset hints.
 * Extension pattern only — no filename or host assumptions.
 */
export function findLoaderUrlInHints(assetUrls: string[]): string | null {
  for (const u of assetUrls ?? []) {
    try {
      const parsed = new URL(u);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    } catch {
      continue;
    }
    if (classifyUnityArtifact(u) === 'loader') return u;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace comment spans with spaces, preserving offsets. String-aware so
 * `//` inside quotes is not treated as a comment start.
 */
function maskComments(text: string): string {
  const out = text.split('');
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') {
        out[j] = ' ';
        j++;
      }
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let j = i; j < stop; j++) {
        if (out[j] !== '\n') out[j] = ' ';
      }
      i = stop;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Extract `key: "value"` literals for known Unity keys. Property READS
 * (`m.dataUrl`) never match: a colon followed by a quoted string is
 * required, so reads without assigned literals are excluded by construction.
 */
function extractKnownKeyValues(text: string): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const key of CONFIG_KEYS) {
    const re = new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`);
    const m = text.match(re);
    if (m) raw[key] = m[1];
  }
  return raw;
}

/**
 * Detect whether JS text EXPECTS an external Unity config without providing
 * literal values: a `createUnityInstance(` call, or member reads like
 * `m.dataUrl` / `config.codeUrl` of known keys. Signal only — never values.
 */
function detectExpectedConfig(text: string): boolean {
  if (/createUnityInstance\s*\(/.test(text)) return true;
  const memberRead = new RegExp(
    `\\b[A-Za-z_$][\\w$]*\\.(${CONFIG_KEYS.filter((k) => k !== 'loaderUrl').join('|')})\\b`,
  );
  return memberRead.test(text);
}

/**
 * Split a parenthesized argument list starting AFTER the open paren into
 * top-level argument strings. Quote/comment/escape aware. Returns null
 * when parentheses never balance (truncated or hostile input).
 */
function splitTopLevelArgs(text: string, startIndex: number): string[] | null {
  const args: string[] = [];
  let depth = 1; // already inside the call's open paren
  let current = '';
  let i = startIndex;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1] ?? '';
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0 && ch === ')') {
        args.push(current);
        return args;
      }
      if (depth < 1) return null;
      current += ch;
      i++;
      continue;
    }
    if (ch === ',' && depth === 1) {
      args.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  return null;
}

/**
 * Extract a balanced `{...}` region starting at the given open-brace index.
 * Quote/escape/comment aware. Returns null when unbalanced.
 */
function extractBalanced(
  text: string,
  openIndex: number,
  open: '{',
  close: '}',
): string | null {
  if (text[openIndex] !== open) return null;
  let depth = 0;
  let quote: string | null = null;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1] ?? '';
    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
    i++;
  }
  return null;
}
