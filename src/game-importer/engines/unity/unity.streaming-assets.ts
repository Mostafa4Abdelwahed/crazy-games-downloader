import { normalizePackagePath } from '../../core/path-utils';

/**
 * Generic Unity WebGL StreamingAssets dependency helpers (engine knowledge,
 * NOT source-specific).
 *
 * The Unity config value `streamingAssetsUrl` (usually the literal
 * `"StreamingAssets"`) is treated as an EXPECTATION/DISCOVERY SIGNAL only:
 * it tells us under which path prefix the game will request extra files at
 * runtime, but never which filenames exist. Actual files are discovered from
 * observed network requests (runtime) or quoted `StreamingAssets/...`
 * references in already-downloaded text (static) — never hardcoded, never
 * crawled blindly (StreamingAssets is normally not directory-listable).
 */

export interface StreamingAssetsDiscoveryOptions {
  /** Max distinct StreamingAssets files to package. */
  maxFiles: number;
  /** Max total StreamingAssets bytes to package. */
  maxTotalBytes: number;
  /** Upper bound for the runtime network-observation window. */
  discoveryTimeoutMs: number;
  /** Per-file download timeout. */
  requestTimeoutMs: number;
}

export function defaultStreamingAssetsOptions(): StreamingAssetsDiscoveryOptions {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    maxFiles: num(process.env.UNITY_STREAMING_ASSETS_MAX_FILES, 200),
    maxTotalBytes: num(
      process.env.UNITY_STREAMING_ASSETS_MAX_BYTES,
      Number(process.env.IMPORT_MAX_DOWNLOAD_BYTES ?? 512 * 1024 * 1024),
    ),
    discoveryTimeoutMs: num(
      process.env.UNITY_STREAMING_ASSETS_DISCOVERY_TIMEOUT_MS,
      45_000,
    ),
    requestTimeoutMs: num(
      process.env.UNITY_STREAMING_ASSETS_REQUEST_TIMEOUT_MS,
      60_000,
    ),
  };
}

/** Exact Unity StreamingAssets directory segment (case-sensitive). */
export const STREAMING_ASSETS_SEGMENT = 'StreamingAssets';

/**
 * Normalize a raw `streamingAssetsUrl` config value into a relative prefix
 * path (e.g. `"StreamingAssets"`, `"./StreamingAssets/"`,
 * `"webgl/StreamingAssets"`). Absolute http(s) URLs are reduced to their
 * pathname prefix. Returns null when no usable prefix can be derived
 * (empty, non-http absolute URL, traversal).
 */
export function normalizeStreamingPrefix(
  raw: string | undefined,
): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let pathname: string;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    // Absolute URL form — keep only the path prefix (origin-agnostic).
    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      pathname = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    pathname = trimmed.replace(/\\/g, '/');
  }
  // Strip leading ./ and / markers; keep genuine nesting (webgl/...).
  let p = pathname.trim();
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  while (p.endsWith('/')) p = p.slice(0, -1);
  if (!p) return null;
  const segments = p
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '.' || s === '..')) return null;
  if (segments.some((s) => s.length > 255)) return null;
  // The prefix must contain the StreamingAssets segment (Unity convention).
  if (!segments.includes(STREAMING_ASSETS_SEGMENT)) return null;
  const normalized = segments.join('/');
  if (normalized.length > 512) return null;
  try {
    normalizePackagePath(`${normalized}/.probe`);
  } catch {
    return null;
  }
  return normalized;
}

/**
 * Resolve the absolute remote base URL of the StreamingAssets prefix.
 * Returns null when either input is unparseable.
 */
export function streamingBaseUrl(
  streamingAssetsUrl: string,
  configBaseUrl: string,
): string | null {
  try {
    return new URL(streamingAssetsUrl, configBaseUrl).toString();
  } catch {
    return null;
  }
}

/** Split a URL pathname into decoded segments (never throws). */
function decodedPathSegments(url: URL): string[] {
  return url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/**
 * True when an observed request URL belongs to the Unity game's
 * StreamingAssets tree.
 *
 * Matching strategy (generic, no filenames):
 * - When the expected base resolves, the request path must live under the
 *   base path (same pathname prefix, segment-boundary aware). Origins may
 *   differ (CDN splits) — host allowlisting is enforced separately by the
 *   source policy, never here.
 * - As a fallback (unresolvable base), the decoded path must contain the
 *   exact `StreamingAssets` segment.
 */
export function isStreamingAssetsUrl(
  requestUrl: string,
  base: { streamingAssetsUrl?: string; configBaseUrl: string },
): boolean {
  let req: URL;
  try {
    req = new URL(requestUrl, base.configBaseUrl);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(req.protocol)) return false;
  const reqSegs = decodedPathSegments(req);
  if (!reqSegs.includes(STREAMING_ASSETS_SEGMENT)) return false;

  const raw = (base.streamingAssetsUrl ?? '').trim();
  if (!raw) return true;
  let baseUrl: URL;
  try {
    baseUrl = new URL(raw, base.configBaseUrl);
  } catch {
    return true;
  }
  const baseSegs = decodedPathSegments(baseUrl);
  if (baseSegs.length === 0) return true;
  if (reqSegs.length < baseSegs.length) return false;
  for (let i = 0; i < baseSegs.length; i++) {
    if (reqSegs[i] !== baseSegs[i]) return false;
  }
  return true;
}

/**
 * Map an observed StreamingAssets request URL to its package-relative path
 * (`StreamingAssets/...`), preserving nesting. Strips query/fragment,
 * decodes percent-encoding, rejects traversal/absolute escapes via
 * {@link normalizePackagePath}. Returns null for non-StreamingAssets URLs
 * or unsafe paths. Never flattens directories.
 */
export function toStreamingAssetsPackagePath(
  requestUrl: string,
  base: { streamingAssetsUrl?: string; configBaseUrl: string },
): string | null {
  if (!isStreamingAssetsUrl(requestUrl, base)) return null;
  let req: URL;
  try {
    req = new URL(requestUrl, base.configBaseUrl);
  } catch {
    return null;
  }
  const segs = decodedPathSegments(req);
  const idx = segs.indexOf(STREAMING_ASSETS_SEGMENT);
  if (idx === -1 || idx === segs.length - 1) return null; // prefix itself only
  const rel = segs.slice(idx).join('/');
  if (rel.includes('\0')) return null;
  try {
    const safe = normalizePackagePath(rel);
    if (!safe.startsWith(`${STREAMING_ASSETS_SEGMENT}/`)) return null;
    return safe;
  } catch {
    return null;
  }
}

/**
 * Resolve a StreamingAssets package-relative path back to an absolute
 * remote URL against the authorized remote base (for downloading).
 */
export function toRemoteStreamingAssetsUrl(
  packagePath: string,
  base: { streamingAssetsUrl: string; configBaseUrl: string },
): string | null {
  let safe: string;
  try {
    safe = normalizePackagePath(packagePath);
  } catch {
    return null;
  }
  if (!safe.startsWith(`${STREAMING_ASSETS_SEGMENT}/`)) return null;
  const suffix = safe.slice(STREAMING_ASSETS_SEGMENT.length + 1);
  if (!suffix) return null;
  try {
    const baseAbs = new URL(base.streamingAssetsUrl, base.configBaseUrl);
    const basePath =
      baseAbs.pathname.endsWith('/') || baseAbs.pathname === ''
        ? baseAbs.pathname
        : `${baseAbs.pathname}/`;
    const encoded = suffix
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    const out = new URL(baseAbs.toString());
    out.pathname = `${basePath}${encoded}`.replace(/\/+/g, '/');
    out.search = '';
    out.hash = '';
    return out.toString();
  } catch {
    return null;
  }
}

/**
 * True when a URL's decoded path carries the exact `StreamingAssets`
 * segment, regardless of origin or base prefix. Used as a tightly scoped
 * fallback when the configured prefix base does not cover the actual load
 * location (e.g. CDN-split layouts): still restricted to Unity game
 * assets, never a blanket capture.
 */
export function hasStreamingAssetsSegment(requestUrl: string): boolean {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname);
  } catch {
    return false;
  }
  return /(^|\/)StreamingAssets\//.test(pathname);
}

/**
 * Derive the absolute StreamingAssets directory URL from any absolute URL
 * pointing at or under it (e.g. a portal delivery `StreamingAssets` dir
 * URL or a `StreamingAssets/x.bank` file URL). Returns null unless the
 * decoded path contains the exact `StreamingAssets` segment.
 */
export function streamingPrefixOfUrl(absUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(absUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const segs = parsed.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const idx = segs.indexOf(STREAMING_ASSETS_SEGMENT);
  if (idx === -1) return null;
  const out = new URL(parsed.toString());
  out.pathname = `/${segs
    .slice(0, idx + 1)
    .map((s) => encodeURIComponent(s))
    .join('/')}/`.replace(/\/+/g, '/');
  out.search = '';
  out.hash = '';
  return out.toString();
}

/**
 * Find the first adapter hint usable as a `streamingAssetsUrl` signal:
 * an absolute http(s) URL at/under the StreamingAssets prefix that is NOT
 * itself a core build artifact. Directory URLs reduce to themselves;
 * file URLs reduce to their StreamingAssets directory.
 */
export function findStreamingAssetsHint(
  assetUrls: string[],
  maxHints = 200,
): string | null {
  let checked = 0;
  for (const u of assetUrls ?? []) {
    if (checked++ >= maxHints) break;
    const prefix = streamingPrefixOfUrl(u);
    if (prefix) return prefix;
  }
  return null;
}

const QUOTED_STREAMING_REF =
  /["']((?:\.{0,2}\/)?(?:[\w.\-+]+\/)*StreamingAssets\/[^"'\s]+)["']/g;

/**
 * Statically extract `StreamingAssets/...` references from already
 * downloaded text (loader/framework/config JS). Pure static scan — never
 * executed. Returns package-relative paths (query/fragment stripped).
 * Used as a cheap supplement to runtime network observation.
 */
export function extractStreamingAssetsRefs(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const capped = text.slice(0, 1_000_000);
  QUOTED_STREAMING_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUOTED_STREAMING_REF.exec(capped)) !== null) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    const withoutQuery = raw.split('?')[0].split('#')[0];
    if (!withoutQuery) continue;
    let decoded = withoutQuery;
    try {
      decoded = decodeURIComponent(withoutQuery);
    } catch {
      /* keep raw */
    }
    const normalized = decoded.replace(/\\/g, '/').replace(/^\.\//, '');
    const idx = normalized.split('/').indexOf(STREAMING_ASSETS_SEGMENT);
    if (idx === -1) continue;
    const rel = normalized
      .split('/')
      .slice(idx)
      .join('/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!rel || rel === STREAMING_ASSETS_SEGMENT) continue;
    try {
      const safe = normalizePackagePath(rel);
      if (!safe.startsWith(`${STREAMING_ASSETS_SEGMENT}/`)) continue;
      if (!seen.has(safe)) {
        seen.add(safe);
        out.push(safe);
        if (out.length >= 500) break;
      }
    } catch {
      continue;
    }
  }
  return out;
}
