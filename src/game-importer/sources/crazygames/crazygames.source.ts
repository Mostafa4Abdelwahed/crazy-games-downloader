import { Injectable } from '@nestjs/common';
import { SecureDownloader } from '../../core/downloader';
import { AuthorizedSourcePolicy } from '../authorized-source-policy';
import {
  GameSourceAdapter,
  ResolvedGameSource,
  SourceAccessRestrictedError,
  SourceContext,
  SourceRedirectedError,
} from '../source.interface';
import { CrazyGamesParser, isCrazyGamesHost } from './crazygames.parser';

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

    return {
      source: this.name,
      canonicalUrl: canonical,
      gameUrl: frameUrl,
      entryUrl: frame.finalUrl,
      assetUrls,
      ...(metadata ? { metadata } : {}),
    };
  }
}
