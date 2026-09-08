import { Injectable } from '@nestjs/common';
import { SecureDownloader } from '../../core/downloader';
import { AuthorizedSourcePolicy } from '../authorized-source-policy';
import {
  DiscoveredGame,
  GameSourceAdapter,
  ListedGamesResult,
  ResolvedGameSource,
  SourceAccessRestrictedError,
  SourceContext,
  SourceRedirectedError,
} from '../source.interface';
import { CrazyGamesParser, isCrazyGamesHost } from './crazygames.parser';
import { CrazyGamesGameLink } from './crazygames.types';
import { UnityBuildRoleUrls } from '../source.interface';

const ADAPTER_NAME = 'crazygames';

/**
 * Source adapter for authorized CrazyGames game pages.
 *
 * - `canHandle()` is a pure hostname check (no I/O).
 * - `resolve()` validates SourcePolicy BEFORE fetching, uses only the
 *   SSRF-guarded `SecureDownloader` (redirects revalidated inside it),
 *   re-checks policy on every final URL, and only reads the PUBLIC delivery
 *   configuration (game iframe, metadata, script/style URLs) exactly as
 *   served to a browser.
 * - Never attempts authentication bypass, bot-protection circumvention,
 *   hidden/private API discovery, DRM or signed-URL workarounds. Any
 *   access-control signal fails the resolution instead.
 * - No asset filenames are hardcoded; engine-specific interpretation
 *   (e.g. Unity loader config) is left to the engine importers.
 */
@Injectable()
export class CrazyGamesSourceAdapter implements GameSourceAdapter {
  readonly name = ADAPTER_NAME;

  constructor(
    private readonly parser: CrazyGamesParser,
    private readonly downloader: SecureDownloader,
    private readonly authorized: AuthorizedSourcePolicy,
  ) {}

  canHandle(url: string): boolean {
    let host = '';
    try {
      host = new URL(url.trim()).hostname;
    } catch {
      return false;
    }
    return isCrazyGamesHost(host);
  }

  /**
   * Discover game links from a listing page (category/tag/home/…). Same
   * authorization + SSRF + access-restriction guards as `resolve()`; returns
   * canonical `/game/{slug}` URLs ready for a batch import.
   */
  async listGames(
    url: string,
    context: SourceContext = {},
  ): Promise<ListedGamesResult> {
    const canonical = this.parser.normalizeUrl(url);

    // 1. SourcePolicy BEFORE any network I/O.
    this.authorized.assertAuthorized(canonical);

    const timeoutMs = context.timeoutMs ?? 30_000;

    // 2. Fetch the public listing page (SSRF + redirect-safe downloader).
    const page = await this.downloader.fetchBuffer(canonical, {
      timeoutMs,
      ...(typeof context.maxBytes === 'number'
        ? { maxBytes: context.maxBytes }
        : {}),
    });

    // 3. Revalidate: final URL must still be authorized AND on-platform.
    this.authorized.assertAuthorized(page.finalUrl);
    if (!this.canHandle(page.finalUrl)) {
      throw new SourceRedirectedError(
        'Source redirected off the CrazyGames platform; refusing to follow.',
      );
    }

    const html = page.body.toString('utf8').slice(0, 3_000_000);
    if (this.parser.detectAccessRestriction(html)) {
      throw new SourceAccessRestrictedError(
        'Source page indicates restricted access; will not attempt to bypass it.',
      );
    }

    // The real grid lives in the Next.js app state; anchors are only a
    // fallback (and an undercount on real pages). Merge, dedupe, cap.
    const MAX_GAMES = 200;
    const anchorLinks = this.parser.extractGameLinks(
      html,
      page.finalUrl,
      MAX_GAMES,
    );
    const stateLinks = this.parser.extractNextDataGames(html, MAX_GAMES);
    const links: CrazyGamesGameLink[] = [];
    const seen = new Set<string>();
    for (const link of [...stateLinks, ...anchorLinks]) {
      if (!link.url || seen.has(link.url)) continue;
      seen.add(link.url);
      links.push(link);
      if (links.length >= MAX_GAMES) break;
    }

    const games: DiscoveredGame[] = links.map((link) => ({
      url: link.url,
      title: link.title,
      ...(link.thumbnail ? { thumbnail: link.thumbnail } : {}),
    }));
    if (games.length > 0) return { games };

    // No links: explain exactly what the served page contained so the
    // console can surface an actionable message.
    const diag = this.parser.diagnoseListing(html, page.finalUrl);
    const tag = diag.pageTitle
      ? `Page "${diag.pageTitle}" served ${diag.totalAnchors} link(s)`
      : `Page served ${diag.totalAnchors} link(s)`;
    let note: string;
    if (diag.accessRestricted) {
      note = 'Page signals restricted access (challenge/captcha).';
    } else if (diag.gameAnchors === 0 && diag.totalAnchors > 0) {
      note = `${tag}, but none pointed at /game/{slug} pages.`;
    } else if (diag.totalAnchors === 0 && diag.hasNextData) {
      note = `${tag} and no static <a> anchors — the game grid appears to be client-side JS rendered.`;
    } else if (diag.totalAnchors === 0) {
      note = `${tag} and no <a> anchors at all; the page may be a consent/blocking page.`;
    } else {
      note = `${tag}, all non-game.`;
    }
    return { games: [], note };
  }

  async resolve(
    url: string,
    context: SourceContext = {},
  ): Promise<ResolvedGameSource> {
    const canonical = this.parser.normalizeUrl(url);

    // 1. SourcePolicy BEFORE any network I/O.
    this.authorized.assertAuthorized(canonical);

    const timeoutMs = context.timeoutMs ?? 30_000;
    const maxBytes = context.maxBytes;

    // 2. Fetch the public game page (SSRF + redirect-safe downloader).
    const page = await this.downloader.fetchBuffer(canonical, {
      timeoutMs,
      ...(typeof maxBytes === 'number' ? { maxBytes } : {}),
    });

    // 3. Revalidate: final URL must still be authorized AND on-platform.
    this.authorized.assertAuthorized(page.finalUrl);
    if (!this.canHandle(page.finalUrl)) {
      throw new SourceRedirectedError(
        'Source redirected off the CrazyGames platform; refusing to follow.',
      );
    }

    const html = page.body.toString('utf8').slice(0, 1_000_000);
    if (this.parser.detectAccessRestriction(html)) {
      throw new SourceAccessRestrictedError(
        'Source page indicates restricted access; will not attempt to bypass it.',
      );
    }

    const discovery = this.parser.discoverFromPage(html, page.finalUrl);
    const metadata =
      discovery.meta.title || discovery.meta.thumbnail
        ? { ...discovery.meta }
        : undefined;

    // M3.1: explicit portal delivery config (game document, loader bundle,
    // build assets) supplements the iframe signal. Iframes remain the
    // primary embed signal; delivery frame URLs are the fallback.
    const delivery = discovery.delivery;
    const frameUrl = discovery.frameUrl ?? delivery?.frameUrls[0] ?? null;
    const deliveryAssets: string[] = [
      ...(delivery?.loaderUrl ? [delivery.loaderUrl] : []),
      ...(delivery?.configAssets ?? []),
    ];

    // 4. Unsupported layout: no playable embed — return a best-effort
    //    resolution so engine detection (not Unity-forcing) decides next.
    if (!frameUrl) {
      return {
        source: this.name,
        canonicalUrl: canonical,
        assetUrls: [],
        ...(metadata ? { metadata } : {}),
      };
    }

    // 5. Fetch the public game frame (same guards as the page).
    const frame = await this.downloader.fetchBuffer(frameUrl, {
      timeoutMs,
      ...(typeof maxBytes === 'number' ? { maxBytes } : {}),
    });
    this.authorized.assertAuthorized(frame.finalUrl);

    const frameHtml = frame.body.toString('utf8').slice(0, 1_000_000);
    if (this.parser.detectAccessRestriction(frameHtml)) {
      throw new SourceAccessRestrictedError(
        'Game frame indicates restricted access; will not attempt to bypass it.',
      );
    }

    const frameAssets = this.parser.assetsFromFrame(frameHtml, frame.finalUrl);
    const assetUrls = [...frameAssets.assetUrls];
    for (const u of deliveryAssets) {
      if (!assetUrls.includes(u)) assetUrls.push(u);
    }
    const unityBuild = toUnityBuildRoles(delivery?.loaderUrl, delivery);

    return {
      source: this.name,
      canonicalUrl: canonical,
      gameUrl: frameUrl,
      entryUrl: frame.finalUrl,
      assetUrls,
      ...(unityBuild ? { unityBuild } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }
}

/**
 * Map portal delivery URLs to role-labeled Unity build hints (platform
 * knowledge stays here; keys/values are engine-vocabulary + URLs only).
 * Accepts absolute http(s) URLs and scheme-less relative refs (resolved
 * later against the build base); refuses anything else. Returns undefined
 * when the delivery config names no labeled build.
 */
function toUnityBuildRoles(
  loaderUrl: string | undefined,
  delivery: { buildRoles: Record<string, string> } | undefined,
): UnityBuildRoleUrls | undefined {
  const roles: UnityBuildRoleUrls = {};
  const take = (field: keyof UnityBuildRoleUrls, raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const v = raw.trim();
    if (!v || v.length > 2000) return;
    try {
      const parsed = new URL(v);
      if (!['http:', 'https:'].includes(parsed.protocol)) return;
      roles[field] = parsed.toString();
      return;
    } catch {
      /* not absolute — maybe a scheme-less relative ref */
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return;
    if (/[\s"'<>\\]/.test(v)) return;
    roles[field] = v;
  };
  if (loaderUrl) take('loaderUrl', loaderUrl);
  const keyed = delivery?.buildRoles ?? {};
  // `wasmUrl` is an accepted alias of the wasm code URL.
  for (const k of ['codeUrl', 'wasmCodeUrl', 'wasmUrl'] as const) {
    if (roles.codeUrl) break;
    if (keyed[k]) take('codeUrl', keyed[k]);
  }
  for (const k of [
    'dataUrl',
    'frameworkUrl',
    'streamingAssetsUrl',
    'memoryUrl',
    'symbolsUrl',
  ] as const) {
    if (keyed[k] && roles[k] === undefined) take(k, keyed[k]);
  }
  return Object.keys(roles).length > 0 ? roles : undefined;
}
