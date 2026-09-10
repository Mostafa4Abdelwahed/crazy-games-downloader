import { Injectable } from '@nestjs/common';
import {
  CrazyGamesDeliveryConfig,
  CrazyGamesFrameAssets,
  CrazyGamesFrameDiscovery,
  CrazyGamesGameLink,
  CrazyGamesListingDiagnostics,
  CrazyGamesPageMeta,
} from './crazygames.types';

/** Hosts owned by the CrazyGames platform. Subdomains included. */
const CRAZYGAMES_ROOT = 'crazygames.com';

/** Iframe sources that are never the game embed (ads/social/video). */
const NON_GAME_IFRAME_HOSTS = [
  'googlesyndication.com',
  'doubleclick.net',
  'googleadservices.com',
  'facebook.com',
  'facebook.net',
  'twitter.com',
  'x.com',
  'youtube.com',
  'youtube-nocookie.com',
  'vimeo.com',
  'instagram.com',
];

export function isCrazyGamesHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === CRAZYGAMES_ROOT || host.endsWith(`.${CRAZYGAMES_ROOT}`);
}

/**
 * Find every object in the `__NEXT_DATA__` tree shaped like a paginated
 * game list (`{ items: GameItem[], pagination: {...} }`). Matched lists
 * are not descended into; the deepest page-state bags win.
 */
function collectGamesLists(
  node: unknown,
  out: Array<Array<Record<string, unknown>>>,
): void {
  if (Array.isArray(node)) {
    for (const child of node) collectGamesLists(child, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.items) && obj.items.length > 0 && obj.pagination) {
    out.push(obj.items as Array<Record<string, unknown>>);
    return;
  }
  for (const value of Object.values(obj)) collectGamesLists(value, out);
}

/** Collapse whitespace (including newlines) to single spaces and trim. */
function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Minimal HTML entity decoding for link text/titles. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#0*39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/gi, "'");
}

/**
 * Pure, static HTML parsing for CrazyGames pages. No network I/O, no JS
 * execution — regex-based extraction of the PUBLIC delivery configuration
 * (game iframe, metadata, script/style URLs) exactly as served to browsers.
 */
@Injectable()
export class CrazyGamesParser {
  /**
   * Canonicalize a CrazyGames URL: trim, validate scheme, lowercase host,
   * strip `#fragment`, drop redundant trailing slash. The query string is
   * ALWAYS preserved (it may carry authorization/signature parameters that
   * must never be stripped or bypassed).
   */
  normalizeUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Malformed source URL: ${rawUrl}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(
        `Unsupported protocol "${parsed.protocol}". Only http/https allowed.`,
      );
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  }

  extractMeta(html: string): CrazyGamesPageMeta {
    const meta: CrazyGamesPageMeta = {};
    const ogTitle = this.metaContent(html, 'og:title');
    const titleMatch = html.match(/<title[^>]*>([^<]{1,300})<\/title\s*>/i);
    meta.title = (ogTitle ?? titleMatch?.[1] ?? '').trim() || undefined;
    meta.thumbnail = this.metaContent(html, 'og:image');
    return meta;
  }

  /**
   * Find the playable game embed. Ranking: (1) iframe whose src path looks
   * like a game delivery path (game/embed/play), (2) any remaining
   * non-ad iframe. Returns null when the page exposes no game embed
   * (unsupported layout — caller falls back to page-level detection).
   */
  extractGameFrameUrl(html: string, baseUrl: string): string | null {
    const srcs = this.iframeSrcs(html);
    const absolute: string[] = [];
    for (const src of srcs) {
      const abs = this.toAbsoluteHttp(src, baseUrl);
      if (!abs || this.isNonGameEmbed(abs)) continue;
      absolute.push(abs);
    }
    if (absolute.length === 0) return null;
    const gamey = absolute.filter((u) => this.looksLikeGamePath(u));
    return gamey[0] ?? absolute[0];
  }

  /** Asset hints from any HTML doc: scripts + stylesheets, absolute http(s). */
  extractAssetUrls(html: string, baseUrl: string, max = 200): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string) => {
      const abs = this.toAbsoluteHttp(raw, baseUrl);
      if (!abs || seen.has(abs)) return;
      seen.add(abs);
      if (out.length < max) out.push(abs);
    };
    const scriptRe = /<script[^>]+src\s*=\s*["']([^"']{1,2000})["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = scriptRe.exec(html)) !== null) push(m[1]);
    const linkRe = /<link[^>]+href\s*=\s*["']([^"']{1,2000})["'][^>]*>/gi;
    while ((m = linkRe.exec(html)) !== null) {
      const tag = m[0];
      if (!/rel\s*=\s*["']?(stylesheet|preload|modulepreload)/i.test(tag)) {
        continue;
      }
      push(m[1]);
    }
    return out;
  }

  discoverFromPage(html: string, finalUrl: string): CrazyGamesFrameDiscovery {
    return {
      frameUrl: this.extractGameFrameUrl(html, finalUrl),
      pageAssetUrls: this.extractAssetUrls(html, finalUrl),
      meta: this.extractMeta(html),
      delivery: this.extractDeliveryConfig(html),
    };
  }

  assetsFromFrame(frameHtml: string, frameUrl: string): CrazyGamesFrameAssets {
    return { assetUrls: this.extractAssetUrls(frameHtml, frameUrl) };
  }

  /**
   * Extract the game entry URL and loader type from a CrazyGames game
   * frame's inline `var options = {...}` delivery manifest.  For HTML5
   * games this yields the actual game document URL; Unity games use
   * `unityLoaderUrl` which is handled separately by the delivery config.
   */
  extractGameEntry(frameHtml: string): {
    loader?: string;
    gameEntryUrl?: string;
  } {
    const loaderMatch = frameHtml
      .slice(0, 2_000_000)
      .match(/["']loader["']\s*:\s*["']([a-zA-Z0-9_.-]{1,40})["']/);
    const loader = loaderMatch?.[1] ?? undefined;
    const block = frameHtml
      .slice(0, 2_000_000)
      .match(/["']loaderOptions["']\s*:\s*\{([^}]*)\}/);
    let gameEntryUrl: string | undefined;
    if (block) {
      const urlMatch = block[1].match(
        /["']url["']\s*:\s*["']([^"']{1,2000})["']/,
      );
      if (urlMatch) {
        gameEntryUrl = normalizeDeliveryUrl(urlMatch[1]) ?? undefined;
      }
    }
    return { loader, gameEntryUrl };
  }

  /**
   * Discover game links from a listing page (category/tag/home). Anchors
   * pointing at `/game/{slug}` are canonicalized and de-duplicated; the
   * title comes from the link's image alt or text, the thumbnail from the
   * link's first image. Sorted by page order, capped at `max`.
   */
  extractGameLinks(
    html: string,
    baseUrl: string,
    max = 50,
  ): CrazyGamesGameLink[] {
    const cap = Math.max(1, Math.min(max, 200));
    const out: CrazyGamesGameLink[] = [];
    const seen = new Set<string>();
    const anchorRe =
      /<a\b[^>]*?\bhref\s*=\s*["']([^"']{1,2000})["'][^>]*>([\s\S]*?)<\/a\s*>/gi;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(html.slice(0, 3_000_000))) !== null) {
      if (out.length >= cap) break;
      const url = this.toGamePageUrl(m[1], baseUrl);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const inner = m[2] ?? '';
      const slug = this.slugFromGameUrl(url);
      const title = this.gameLinkTitle(inner, slug);
      const thumbnail = this.gameLinkThumbnail(inner, baseUrl);
      out.push({
        url,
        title,
        ...(thumbnail ? { thumbnail } : {}),
      });
    }
    return out;
  }

  /**
   * Extract the full game grid from the page's `__NEXT_DATA__` app state
   * (`props.pageProps.games.items` and equivalent shapes). Next.js only
   * server-renders a handful of anchors while the whole paginated listing
   * (e.g. 60 games) lives in this JSON — so anchors alone undercount real
   * pages. Returns the largest matching list; `[]` when the shape differs,
   * the caller then falls back to anchor extraction.
   */
  extractNextDataGames(html: string, max = 200): CrazyGamesGameLink[] {
    const cap = Math.max(1, Math.min(max, 200));
    const blob = this.nextDataBlob(html);
    if (!blob) return [];
    let root: unknown;
    try {
      root = JSON.parse(blob);
    } catch {
      return [];
    }
    const lists: Array<Array<Record<string, unknown>>> = [];
    collectGamesLists(root, lists);
    if (lists.length === 0) return [];
    lists.sort((a, b) => b.length - a.length);
    const out: CrazyGamesGameLink[] = [];
    const seen = new Set<string>();
    for (const item of lists[0]) {
      if (out.length >= cap) break;
      const slug = item.slug;
      const name = item.name;
      if (typeof slug !== 'string' || !slug) continue;
      if (typeof name !== 'string' || !name.trim()) continue;
      const url = this.toGamePageUrl(
        `/game/${slug}`,
        'https://www.crazygames.com/',
      );
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = name.trim().slice(0, 120);
      if (!title) continue;
      const cover = item.cover;
      const thumbnail =
        typeof cover === 'string' && cover.length > 0 && cover.length < 300
          ? `https://images.crazygames.com/${cover}?format=auto&quality=100&metadata=none&width=480&height=270`
          : undefined;
      out.push({ url, title, ...(thumbnail ? { thumbnail } : {}) });
    }
    return out;
  }

  /**
   * Extract explicit portal delivery configuration (M3.1): the game
   * document URL(s), loader bundle URL, and Unity build asset URLs as
   * named by the page's own public delivery schema. Structured
   * `__NEXT_DATA__` JSON first, targeted key regexes as fallback.
   * Returns absolute http(s) URLs only — never filenames, never guesses.
   */
  extractDeliveryConfig(html: string): CrazyGamesDeliveryConfig {
    const frameUrls: string[] = [];
    const configAssets: string[] = [];
    const buildRoles: Record<string, string> = {};
    let loaderUrl: string | undefined;
    const push = (arr: string[], raw: string): void => {
      const abs = normalizeDeliveryUrl(raw);
      if (abs && !arr.includes(abs)) arr.push(abs);
    };
    const pushRole = (key: string, raw: string): void => {
      if (key in buildRoles) return;
      const role = roleValue(raw);
      if (role) buildRoles[key] = role;
    };

    const blob = this.nextDataBlob(html);
    if (blob) {
      try {
        const found = searchDeliveryKeys(JSON.parse(blob));
        for (const u of found.frameUrls) push(frameUrls, u);
        if (found.loaderUrl) {
          const abs = normalizeDeliveryUrl(found.loaderUrl);
          if (abs) loaderUrl = abs;
        }
        for (const u of found.configAssets) push(configAssets, u);
        for (const [k, v] of Object.entries(found.buildRoles)) pushRole(k, v);
      } catch {
        // Malformed blob — fall through to regex extraction below.
      }
    }
    if (
      frameUrls.length === 0 &&
      !loaderUrl &&
      configAssets.length === 0 &&
      Object.keys(buildRoles).length === 0
    ) {
      const fallback = regexDeliveryConfig(html.slice(0, 2_000_000));
      for (const u of fallback.frameUrls) push(frameUrls, u);
      if (fallback.loaderUrl) {
        const abs = normalizeDeliveryUrl(fallback.loaderUrl);
        if (abs) loaderUrl = abs;
      }
      for (const u of fallback.configAssets) push(configAssets, u);
      for (const [k, v] of Object.entries(fallback.buildRoles)) pushRole(k, v);
    }
    return {
      frameUrls,
      ...(loaderUrl ? { loaderUrl } : {}),
      configAssets,
      buildRoles,
    };
  }

  private nextDataBlob(html: string): string | null {
    const m = html
      .slice(0, 5_000_000)
      .match(
        /<script[^>]+id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/i,
      );
    const blob = (m?.[1] ?? '').trim();
    return blob.length > 0 ? blob : null;
  }

  /**
   * Detect access-control/challenge pages that must NOT be worked around.
   * The adapter refuses these instead of attempting any bypass.
   */
  detectAccessRestriction(html: string): boolean {
    const head = html.slice(0, 50_000);
    return /just a moment|cf-challenge|captcha|access denied|forbidden|please (log|sign) in to (continue|play)|this content is (blocked|restricted|unavailable)/i.test(
      head,
    );
  }

  private metaContent(html: string, property: string): string | undefined {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${property}["'][^>]*>`,
      'i',
    );
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content\s*=\s*["']([^"']{1,2000})["']/i)?.[1];
    return content?.trim() || undefined;
  }

  private iframeSrcs(html: string): string[] {
    const out: string[] = [];
    const re = /<iframe[^>]+src\s*=\s*["']([^"']{1,2000})["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html.slice(0, 1_000_000))) !== null) out.push(m[1]);
    return out;
  }

  /**
   * Canonicalize an anchor href into a CrazyGames game page URL, or null.
   * Accepts `/game/{slug}` (and `/{locale}/game/{slug}`) links on the
   * platform, always http(s), with query + fragment stripped so the same
   * game maps to one canonical URL.
   */
  private toGamePageUrl(ref: string, baseUrl: string): string | null {
    const trimmed = ref.trim();
    if (
      !trimmed ||
      /^(javascript|mailto|tel|data|blob|about):/i.test(trimmed)
    ) {
      return null;
    }
    let abs: URL;
    try {
      abs = new URL(trimmed, baseUrl);
    } catch {
      return null;
    }
    if (!['http:', 'https:'].includes(abs.protocol)) return null;
    if (!isCrazyGamesHost(abs.hostname)) return null;
    const segs = abs.pathname.split('/').filter(Boolean);
    let slug: string | null = null;
    if (segs.length >= 2 && segs[0].toLowerCase() === 'game') {
      slug = segs.slice(1).join('/');
    } else if (segs.length >= 3 && segs[1].toLowerCase() === 'game') {
      slug = segs.slice(2).join('/');
    }
    if (!slug || slug.length > 512) return null;
    if (slug.split('/').some((s) => s === '.' || s === '..')) return null;
    const canonical = new URL(`https://${abs.host.toLowerCase()}`);
    canonical.pathname = `/game/${slug}`;
    return canonical.toString();
  }

  /**
   * Explain why a page did or didn't yield game links, so the console can
   * show an actionable message instead of a blind "no games found".
   */
  diagnoseListing(html: string, baseUrl: string): CrazyGamesListingDiagnostics {
    const slice = html.slice(0, 3_000_000);
    const anchorRe = /<a\b[^>]*?\bhref\s*=\s*["']([^"']{1,2000})["'][^>]*>/gi;
    let totalAnchors = 0;
    let gameAnchors = 0;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(slice)) !== null) {
      totalAnchors += 1;
      if (this.toGamePageUrl(m[1], baseUrl)) gameAnchors += 1;
    }
    const titleMatch = html.match(/<title[^>]*>([^<]{1,300})<\/title\s*>/i);
    return {
      ...(titleMatch?.[1]?.trim() ? { pageTitle: titleMatch[1].trim() } : {}),
      totalAnchors,
      gameAnchors,
      hasNextData: this.nextDataBlob(html) !== null,
      accessRestricted: this.detectAccessRestriction(html),
    };
  }

  private slugFromGameUrl(url: string): string {
    try {
      const segs = new URL(url).pathname.split('/').filter(Boolean);
      return segs.length >= 2 ? segs.slice(1).join('-') : url;
    } catch {
      return url;
    }
  }

  private gameLinkTitle(innerHtml: string, fallback: string): string {
    const alt = innerHtml.match(
      /<img\b[^>]*?\balt\s*=\s*["']([^"']{1,500})["']/i,
    )?.[1];
    const text = cleanText(decodeEntities(innerHtml.replace(/<[^>]+>/g, ' ')));
    const title = text || (alt && alt.trim()) || fallback.replace(/-+/g, ' ');
    return title.trim().slice(0, 120);
  }

  private gameLinkThumbnail(
    innerHtml: string,
    baseUrl: string,
  ): string | undefined {
    const src = innerHtml.match(
      /<img\b[^>]*?\bsrc\s*=\s*["']([^"']{1,2000})["']/i,
    )?.[1];
    return src ? (this.toAbsoluteHttp(src, baseUrl) ?? undefined) : undefined;
  }

  private toAbsoluteHttp(ref: string, baseUrl: string): string | null {
    const trimmed = ref.trim();
    if (!trimmed || /^(data|blob|about|javascript):/i.test(trimmed)) {
      return null;
    }
    try {
      const abs = new URL(trimmed, baseUrl);
      if (!['http:', 'https:'].includes(abs.protocol)) return null;
      return abs.toString();
    } catch {
      return null;
    }
  }

  private isNonGameEmbed(absUrl: string): boolean {
    let host = '';
    try {
      host = new URL(absUrl).hostname.toLowerCase();
    } catch {
      return true;
    }
    return NON_GAME_IFRAME_HOSTS.some(
      (blocked) => host === blocked || host.endsWith(`.${blocked}`),
    );
  }

  private looksLikeGamePath(absUrl: string): boolean {
    try {
      const path = new URL(absUrl).pathname.toLowerCase();
      return (
        path.includes('/game') ||
        path.includes('embed') ||
        path.includes('/play') ||
        path.includes('index.html')
      );
    } catch {
      return false;
    }
  }
}

/**
 * Unity's own config key names, reused here ONLY to recognize absolute
 * asset URL values inside the portal's delivery object. Kept local (not
 * imported from engines/) so the source layer never depends on engine code.
 */
const UNITY_OPTION_KEYS = [
  'dataUrl',
  'frameworkUrl',
  'codeUrl',
  'wasmCodeUrl',
  'wasmUrl',
  'streamingAssetsUrl',
  'memoryUrl',
  'symbolsUrl',
];

/** Normalize a delivery-config URL value: unescape, absolutize, http(s)-only. */
function normalizeDeliveryUrl(raw: string): string | null {
  const unescaped = raw.replace(/\\\//g, '/').trim();
  if (!unescaped) return null;
  const withScheme = unescaped.startsWith('//')
    ? `https:${unescaped}`
    : unescaped;
  try {
    const parsed = new URL(withScheme);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

interface RawDeliveryHits {
  frameUrls: string[];
  loaderUrl?: string;
  configAssets: string[];
  buildRoles: Record<string, string>;
}

/**
 * Recursively search a parsed delivery blob for explicit config keys.
 * Bounded (depth + node caps) and value-typed: only http(s)-looking
 * strings are collected.
 */
function searchDeliveryKeys(
  data: unknown,
  depth = 0,
  seen?: { nodes: number },
): RawDeliveryHits {
  const out: RawDeliveryHits = {
    frameUrls: [],
    configAssets: [],
    buildRoles: {},
  };
  const state = seen ?? { nodes: 0 };
  if (depth > 8 || state.nodes > 2000 || data === null) return out;
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'object' && item !== null) {
        state.nodes++;
        mergeHits(out, searchDeliveryKeys(item, depth + 1, state));
      }
    }
    return out;
  }
  if (typeof data !== 'object') return out;
  const desktops: string[] = [];
  const mobiles: string[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (key === 'desktopUrl') desktops.push(value);
      else if (key === 'mobileUrl') mobiles.push(value);
      else if (key === 'unityLoaderUrl' && !out.loaderUrl) {
        out.loaderUrl = value;
      }
    } else if (
      key === 'unityConfigOptions' &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      for (const [optKey, optVal] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (UNITY_OPTION_KEYS.includes(optKey) && typeof optVal === 'string') {
          out.configAssets.push(optVal);
          if (!(optKey in out.buildRoles)) out.buildRoles[optKey] = optVal;
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      state.nodes++;
      mergeHits(out, searchDeliveryKeys(value, depth + 1, state));
    }
  }
  out.frameUrls.push(...desktops, ...mobiles);
  return out;
}

function mergeHits(into: RawDeliveryHits, from: RawDeliveryHits): void {
  for (const u of from.frameUrls) {
    if (!into.frameUrls.includes(u)) into.frameUrls.push(u);
  }
  if (!into.loaderUrl && from.loaderUrl) into.loaderUrl = from.loaderUrl;
  for (const u of from.configAssets) {
    if (!into.configAssets.includes(u)) into.configAssets.push(u);
  }
  for (const [k, v] of Object.entries(from.buildRoles)) {
    if (!(k in into.buildRoles)) into.buildRoles[k] = v;
  }
}

/**
 * Normalize a delivery-config option value into a role-labeled engine hint:
 * absolute http(s) URLs stay absolute, scheme-relative (`//host/…`) gains
 * `https:`, and scheme-less relative refs are kept raw for later
 * base-resolution by the engine importer. Anything else is refused.
 */
function roleValue(raw: string): string | null {
  const v = raw.replace(/\\\//g, '/').trim();
  if (!v || v.length > 2000) return null;
  const abs = normalizeDeliveryUrl(v);
  if (abs) return abs;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return null;
  if (/[\s"'<>\\]/.test(v)) return null;
  return v;
}

/** Targeted regex fallback for the same semantic key names. */
function regexDeliveryConfig(html: string): RawDeliveryHits {
  const out: RawDeliveryHits = {
    frameUrls: [],
    configAssets: [],
    buildRoles: {},
  };
  const urlGroup = '"((?:https?:)?//[^"]+)"';
  for (const key of ['desktopUrl', 'mobileUrl']) {
    const re = new RegExp(`"${key}"\\s*:\\s*${urlGroup}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) out.frameUrls.push(m[1]);
  }
  const loaderRe = new RegExp(`"unityLoaderUrl"\\s*:\\s*${urlGroup}`);
  const loaderMatch = html.match(loaderRe);
  if (loaderMatch) out.loaderUrl = loaderMatch[1];
  const optionsBlock = html.match(/"unityConfigOptions"\s*:\s*\{([^{}]*)\}/);
  if (optionsBlock) {
    // Per-key capture (not alternation): keeps the semantic role of each
    // value and also accepts scheme-less relative refs (e.g. a bare
    // "StreamingAssets" prefix) that the absolute-URL pattern would miss.
    for (const key of UNITY_OPTION_KEYS) {
      const re = new RegExp(`"${key}"\\s*:\\s*"([^"]{1,2000})"`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(optionsBlock[1])) !== null) {
        const raw = (m[1] ?? '').replace(/\\\//g, '/').trim();
        if (!raw) continue;
        const abs = normalizeDeliveryUrl(raw);
        if (abs && !out.configAssets.includes(abs)) {
          out.configAssets.push(abs);
        }
        if (!(key in out.buildRoles)) {
          const role = roleValue(raw);
          if (role) out.buildRoles[key] = role;
        }
      }
    }
  }
  return out;
}
