import * as path from 'node:path';
import { normalizePackagePath } from '../../core/path-utils';
import {
  STREAMING_ASSETS_SEGMENT,
  hasStreamingAssetsSegment,
} from './unity.streaming-assets';

/**
 * Generic Unity Addressables helpers (engine knowledge, NOT
 * source-specific, NO game-specific filenames).
 *
 * Addressables content (cars, tracks, …) is NOT referenced by the boot
 * config: the game loads a content catalog at
 * `StreamingAssets/aa/settings.json` (Unity's own conventional location,
 * possibly with a platform segment such as `aa/Android/settings.json`)
 * and then fetches the bundles the catalog names — typically long after
 * boot, when gameplay starts. Boot-time network observation can therefore
 * never see these files; the catalog itself is the discovery source.
 *
 * Rules:
 * - The catalog is located by probing `<streaming-assets-base>/aa/...`
 *   candidates (policy-gated, bounded). A missing catalog is NORMAL for
 *   non-Addressables games and simply skips the phase.
 * - Only entries resolvable under a StreamingAssets tree are packaged
 *   (nesting preserved, same canonical top-level layout as bank
 *   dependencies). Absolute external bundle URLs are recorded as
 *   external references and skipped, never bundled.
 * - The packaged catalog is rewritten so packaged entry IDs point at
 *   their local package-relative paths (relative to the catalog file,
 *   which is how Addressables resolves them). Unpackaged IDs stay
 *   verbatim so failures remain visible instead of silently remapped.
 */

export const ADDRESSABLES_SETTINGS_SUFFIX = 'aa/settings.json';

const MAX_CATALOG_IDS = 5000;

/** True when downloaded text suggests the build uses Addressables. */
export function mentionsAddressables(text: string): boolean {
  const capped = text.slice(0, 1_000_000);
  return (
    /addressables/i.test(capped) ||
    /aa\/settings\.json/i.test(capped) ||
    /ResourceManagerRuntimeData/i.test(capped)
  );
}

/**
 * Extract bundle internal IDs from a parsed Addressables content catalog
 * (`m_ResourceLocators[].m_Entries[].m_InternalId`). Non-strings are
 * skipped; the result is capped and deduplicated (first wins).
 */
export function extractCatalogInternalIds(catalog: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return out;
  }
  const locators = (catalog as Record<string, unknown>)['m_ResourceLocators'];
  if (!Array.isArray(locators)) return out;
  for (const locator of locators) {
    if (out.length >= MAX_CATALOG_IDS) break;
    if (!locator || typeof locator !== 'object') continue;
    const entries = (locator as Record<string, unknown>)['m_Entries'];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (out.length >= MAX_CATALOG_IDS) break;
      if (!entry || typeof entry !== 'object') continue;
      const id = (entry as Record<string, unknown>)['m_InternalId'];
      if (typeof id !== 'string') continue;
      const trimmed = id.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Map a catalog/entry absolute URL to its canonical package path
 * (`StreamingAssets/…`, nesting preserved). Returns null when the URL
 * carries no StreamingAssets segment (external bundle — skip, don't
 * flatten) or the path is unsafe.
 */
export function addressablesPackagePath(absUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(absUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (!hasStreamingAssetsSegment(absUrl)) return null;
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
  if (idx === -1 || idx === segs.length - 1) return null;
  const rel = segs.slice(idx).join('/');
  try {
    const safe = normalizePackagePath(rel.split('?')[0].split('#')[0]);
    if (!safe.startsWith(`${STREAMING_ASSETS_SEGMENT}/`)) return null;
    return safe;
  } catch {
    return null;
  }
}

/**
 * Package-relative path of the catalog file itself, derived from the
 * remote catalog URL's StreamingAssets suffix (e.g.
 * `…/StreamingAssets/aa/Android/settings.json` →
 * `StreamingAssets/aa/Android/settings.json`). Falls back to the
 * conventional top-level location when the URL carries no segment.
 */
export function catalogPackagePath(catalogUrl: string): string {
  return (
    addressablesPackagePath(catalogUrl) ??
    `${STREAMING_ASSETS_SEGMENT}/${ADDRESSABLES_SETTINGS_SUFFIX}`
  );
}

/**
 * Rewrite packaged internal IDs to paths relative to the packaged catalog
 * file (how Addressables resolves them). IDs we did not package stay
 * verbatim. Returns the rewritten JSON text, or null when the catalog
 * cannot be losslessly round-tripped.
 */
export function rewriteCatalogIds(
  catalogText: string,
  catalogPkgPath: string,
  packagedById: Map<string, string>,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(catalogText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const catalogDir = path.posix.dirname(catalogPkgPath);
  const locators = (parsed as Record<string, unknown>)['m_ResourceLocators'];
  if (!Array.isArray(locators)) return null;
  for (const locator of locators) {
    if (!locator || typeof locator !== 'object') continue;
    const entries = (locator as Record<string, unknown>)['m_Entries'];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec['m_InternalId'] !== 'string') continue;
      const local = packagedById.get((rec['m_InternalId'] as string).trim());
      if (!local) continue;
      const rel = path.posix.relative(catalogDir, local);
      if (!rel || rel.startsWith('..')) continue;
      rec['m_InternalId'] = rel;
    }
  }
  try {
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

/**
 * Build candidate catalog URLs from known StreamingAssets bases plus the
 * conventional relative location. Absolute http(s) only, deduped.
 */
export function catalogCandidates(
  streamingAssetsUrl: string | undefined,
  configBaseUrl: string,
): string[] {
  const out: string[] = [];
  const push = (abs: string): void => {
    if (!out.includes(abs)) out.push(abs);
  };
  const raw = (streamingAssetsUrl ?? '').trim();
  if (raw) {
    try {
      const base = new URL(raw, configBaseUrl);
      if (['http:', 'https:'].includes(base.protocol)) {
        const dir = base.pathname.endsWith('/')
          ? base.pathname
          : `${base.pathname}/`;
        const candidate = new URL(base.toString());
        candidate.pathname = `${dir}${ADDRESSABLES_SETTINGS_SUFFIX}`.replace(
          /\/+/g,
          '/',
        );
        candidate.search = '';
        candidate.hash = '';
        push(candidate.toString());
      }
    } catch {
      /* unresolvable signal — conventional location below still applies */
    }
  }
  try {
    push(
      new URL(
        `${STREAMING_ASSETS_SEGMENT}/${ADDRESSABLES_SETTINGS_SUFFIX}`,
        configBaseUrl,
      ).toString(),
    );
  } catch {
    /* ignore */
  }
  return out;
}
