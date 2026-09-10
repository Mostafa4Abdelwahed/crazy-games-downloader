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
 * Addressables content (cars, tracks, ...) is NOT referenced by the boot
 * config: the game loads a content catalog long after boot (gameplay
 * start) and then fetches the bundles the catalog names. Boot-time
 * network observation can therefore never see these files; the catalog
 * itself is the discovery source.
 *
 * Audience-recognized shapes (both are handled):
 *
 * 1. THE OLD / OBJECT SHAPE (`m_ResourceLocators[]`):
 *    Pre-1.x / simplified JSON catalogs list
 *    `m_ResourceLocators[].m_Entries[].m_InternalId` strings which are
 *    typically absolute URLs (or catalog-relative refs).
 *
 * 2. THE v1.x ContentCatalogData SHAPE (addressables 1.2x, e.g. 1.22.3):
 *    `StreamingAssets/aa/settings.json` is the ResourceManagerRuntimeData
 *    bootstrap: it has `m_CatalogLocations[].m_InternalId` pointing at the
 *    real catalog (`{UnityEngine.AddressableAssets.Addressables.RuntimePath
 *    }/catalog.json`). The catalog file itself has `m_InternalIds[]` whose
 *    bundle URLs start with that RuntimePath placeholder plus
 *    `m_KeyDataString`/`m_BucketDataString`/`m_EntryDataString` (packed
 *    index structures referencing m_InternalIds BY POSITION). The bundle
 *    URLs are therefore recoverable from `m_InternalIds` alone, and the
 *    packed strings must not be reordered/removed.
 *
 * The `{...RuntimePath}` placeholder resolves at runtime to
 * `<streamingAssetsUrl>/aa/`, which in a packaged game points at the
 * package's own `StreamingAssets/aa/` tree (we rewrite streamingAssetsUrl
 * to a package-relative value), so packed catalogs can be packaged
 * verbatim — the placeholder is re-evaluated against the local page.
 *
 * Rules:
 * - Discovery probes `<streaming-assets-base>/aa/...` candidates
 *   (policy-gated, bounded). A missing catalog is NORMAL for
 *   non-Addressables games and simply skips the phase.
 * - Catalog locations that are not JSON are content-sniffed: Unity
 *   bundle-catalogs (`catalog.bundle`, magic-verified) are packaged
 *   verbatim instead of skipped.
 * - Every packaged catalog artifact also pulls its `.hash` sidecar when
 *   present — the runtime fetches it before the catalog itself.
 * - Only entries resolvable under a StreamingAssets tree are packaged
 *   (nesting preserved, same canonical top-level layout as bank
 *   dependencies). Absolute external bundle URLs are recorded as
 *   external references and skipped, never bundled.
 * - Object-shape catalogs get packaged IDs rewritten to catalog-relative
 *   paths (how Addressables resolves them); packed v1.x catalogs are
 *   kept verbatim because their runtime-path placeholders re-evaluate
 *   against the packaged streamingAssetsUrl.
 */

export const ADDRESSABLES_SETTINGS_SUFFIX = 'aa/settings.json';

/**
 * Unity asset-bundle magic prefixes: `UnityFS` (modern serialized
 * bundles, including bundled Addressables catalogs like
 * `catalog.bundle`) plus the legacy `UnityWeb`/`UnityRaw` markers.
 * Content-sniffed, never extension-sniffed, so any game serving a
 * bundle-catalog under any name is handled without per-game rules.
 */
const UNITY_BUNDLE_MAGICS = ['UnityFS', 'UnityWeb', 'UnityRaw'];

/**
 * True when the bytes start with a Unity asset-bundle magic marker.
 * Used to recognize binary bundle-catalogs (`catalog.bundle`) that a
 * catalog location points at: they are valid Addressables artifacts
 * even though they are not JSON.
 */
export function hasUnityBundleMagic(bytes: Buffer): boolean {
  if (!bytes || bytes.length < 7) return false;
  const head = bytes.subarray(0, 8).toString('ascii');
  return UNITY_BUNDLE_MAGICS.some((m) => head.startsWith(m));
}

/**
 * The `.hash` sidecar URL for a catalog artifact (`catalog.json` →
 * `catalog.hash`, `catalog_2025.10.02.13.29.38.json` →
 * `catalog_2025.10.02.13.29.38.hash`). The Addressables runtime always
 * fetches the sidecar before the catalog itself (remote update check),
 * so a packaged catalog without its sidecar 404s at runtime. Returns
 * null when the URL has no usable extension or already targets a
 * sidecar.
 */
export function hashSidecarUrl(catalogUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(catalogUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const slash = u.pathname.lastIndexOf('/');
  const name = u.pathname.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  if (name.slice(dot + 1).toLowerCase() === 'hash') return null;
  u.pathname = `${u.pathname.slice(0, slash + 1)}${name.slice(0, dot)}.hash`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * Unity runtime-property placeholders found inside Addressables catalog
 * internal IDs on WebGL. They are replaced by Unity at load time; when
 * packaging we keep them verbatim so the local page re-evaluates them
 * against its own streamingAssetsUrl.
 */
export const RUNTIME_PATH_TOKEN =
  '{UnityEngine.AddressableAssets.Addressables.RuntimePath}';
export const STREAMING_SUBFOLDER_TOKEN =
  '{UnityEngine.AddressableAssets.Addressables.StreamingAssetsSubFolder}';

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
 * Shape helpers: the two recognized Addressables JSON payloads.
 * RuntimeData (settings.json) carries `m_CatalogLocations`; a content
 * catalog carries either `m_ResourceLocators` or `m_InternalIds`.
 */
export function isAddressablesSettings(obj: unknown): boolean {
  return (
    !!obj &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    Array.isArray((obj as Record<string, unknown>)['m_CatalogLocations']) &&
    !Array.isArray((obj as Record<string, unknown>)['m_ResourceLocators'])
  );
}

export function isAddressablesCatalog(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const rec = obj as Record<string, unknown>;
  return (
    Array.isArray(rec['m_ResourceLocators']) ||
    Array.isArray(rec['m_InternalIds'])
  );
}

/**
 * Extract catalog locations from an Addressables RuntimeData payload
 * (`settings.json`): `m_CatalogLocations[].m_InternalId`. Returns the raw
 * (possibly placeholder-bearing) internal IDs, capped + deduped.
 */
export function extractCatalogLocations(settings: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!isAddressablesSettings(settings)) return out;
  const locs = (settings as Record<string, unknown>)['m_CatalogLocations'];
  if (!Array.isArray(locs)) return out;
  for (const loc of locs) {
    if (out.length >= MAX_CATALOG_IDS) break;
    if (!loc || typeof loc !== 'object') continue;
    const id = (loc as Record<string, unknown>)['m_InternalId'];
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Extract bundle/internal IDs from a parsed Addressables content catalog.
 * Supports both the object shape (`m_ResourceLocators[].m_Entries[]
 * .m_InternalId`) and the v1.x packed shape (`m_InternalIds[]`).
 * Non-strings are skipped; the result is capped and deduplicated
 * (first wins). The packed shape returns its internal IDs verbatim —
 * the downloader is responsible for expanding runtime-placeholders and
 * filtering to actually-downloadable bundles.
 */
export function extractCatalogInternalIds(catalog: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return out;
  }
  const rec = catalog as Record<string, unknown>;
  const push = (id: unknown): void => {
    if (typeof id !== 'string') return;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  if (Array.isArray(rec['m_InternalIds'])) {
    for (const id of rec['m_InternalIds']) {
      if (out.length >= MAX_CATALOG_IDS) break;
      push(id);
    }
    return out;
  }
  const locators = rec['m_ResourceLocators'];
  if (!Array.isArray(locators)) return out;
  for (const locator of locators) {
    if (out.length >= MAX_CATALOG_IDS) break;
    if (!locator || typeof locator !== 'object') continue;
    const entries = (locator as Record<string, unknown>)['m_Entries'];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (out.length >= MAX_CATALOG_IDS) break;
      if (!entry || typeof entry !== 'object') continue;
      push((entry as Record<string, unknown>)['m_InternalId']);
    }
  }
  return out;
}

/**
 * Replace Unity runtime-property placeholders in a catalog internal ID
 * with concrete package/serving values. Used ONLY to derive the physical
 * download URL for a bundle; packaged catalogs keep placeholders verbatim.
 *
 * - `{...RuntimePath}`      → the `aa/` directory of the catalog server
 *   (e.g. `.../StreamingAssets/aa/`).
 * - `{...StreamingAssetsSubFolder}` → the StreamingAssets base itself.
 *
 * `aaDirUrl` must end with `/` (the directory of settings.json).
 */
export function expandRuntimePath(id: string, aaDirUrl: string): string {
  // Strip trailing slash so the expansion doesn't double up with the `/`
  // that follows the placeholder in catalog entries like
  // `{RuntimePath}/WebGL/x.bundle`.
  const base = aaDirUrl.endsWith('/') ? aaDirUrl.slice(0, -1) : aaDirUrl;
  return id
    .replace(
      /\{UnityEngine\.AddressableAssets\.Addressables\.RuntimePath\}/g,
      base,
    )
    .replace(
      /\{UnityEngine\.AddressableAssets\.Addressables\.StreamingAssetsSubFolder\}/g,
      base,
    );
}

/**
 * Map a catalog/entry absolute URL to its canonical package path
 * (`StreamingAssets/...`, nesting preserved). Returns null when the URL
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
 * Package-relative path of a RemoteData/catalog file, derived from the
 * remote URL's StreamingAssets suffix (e.g.
 * `.../StreamingAssets/aa/Android/settings.json` →
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
 * file (how Addressables resolves object-shape entries). IDs we did not
 * package stay verbatim so failures remain visible instead of silently
 * remapped. Returns the rewritten JSON text, or null when the catalog
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
 * Build candidate Addressables bootstrap URLs from known StreamingAssets
 * bases plus the conventional relative location. Absolute http(s) only,
 * deduped. `streamingAssetsUrl` is the game's configured SA base (may be
 * absolute or relative).
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
