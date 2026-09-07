/**
 * CrazyGames-internal shapes. These types must NEVER leak past
 * `ResolvedGameSource` — engine importers only see the generic contract.
 */

export interface CrazyGamesPageMeta {
  title?: string;
  thumbnail?: string;
}

export interface CrazyGamesFrameDiscovery {
  /** Absolute game frame URL, if a playable embed was found. */
  frameUrl: string | null;
  /** Absolute asset hints (scripts/styles) from the host page. */
  pageAssetUrls: string[];
  meta: CrazyGamesPageMeta;
  /**
   * Explicit delivery configuration embedded in the page (e.g. portal JSON
   * blobs naming the game document, loader, and build assets). Absolute
   * http(s) URLs only; empty when the page exposes none.
   */
  delivery?: CrazyGamesDeliveryConfig;
}

/**
 * Platform delivery-config evidence. Key names below describe the portal's
 * public delivery schema (desktopUrl = game document, unityLoaderUrl =
 * loader bundle, unityConfigOptions = Unity's own config key names with
 * absolute asset URLs). Values are NEVER hardcoded filenames — they are
 * absolute URLs discovered at runtime from the fetched document.
 */
export interface CrazyGamesDeliveryConfig {
  /** Candidate game document URLs (desktop preferred order). */
  frameUrls: string[];
  /** Loader bundle URL, when explicitly named. */
  loaderUrl?: string;
  /** Build asset URLs from the delivery config's Unity options. */
  configAssets: string[];
  /**
   * Keyed Unity option values (`dataUrl`, `frameworkUrl`, `codeUrl`,
   * `streamingAssetsUrl`, …) as exposed by the delivery config. Absolute
   * http(s) URLs or scheme-less relative refs; the adapter maps these to
   * role-labeled engine hints. Empty when the config names no options.
   */
  buildRoles: Record<string, string>;
}

export interface CrazyGamesFrameAssets {
  /** Absolute asset hints (scripts/styles) from the game frame. */
  assetUrls: string[];
}
