/**
 * Source/platform adapter contracts (M2.5).
 *
 * Architecture distinction:
 * - A {@link GameSourceAdapter} identifies and resolves assets from an
 *   authorized source (platform-specific knowledge lives here and ONLY here).
 * - A `GameEngineImporter` (core/engines) understands how to package and
 *   normalize those assets into a `GamePackage` (no source-specific logic).
 *
 * Pipeline: Source URL -> Source Adapter -> ResolvedGameSource ->
 * Engine Detector -> Engine Importer -> Game Package -> Storage.
 */

/** Input context for source resolution (all fields optional). */
export interface SourceContext {
  jobId?: string;
  /** Per-fetch timeout in ms. */
  timeoutMs?: number;
  /** Per-response size cap in bytes. */
  maxBytes?: number;
}

/**
 * Platform-agnostic resolved source. Contains ONLY what an engine importer
 * needs: canonical URL, entry point(s), asset hints, basic metadata.
 * No platform-specific structures leak past this interface.
 */
export interface ResolvedGameSource {
  /** Adapter name that produced this resolution, e.g. 'crazygames'. */
  source: string;
  /** Normalized canonical URL of the authorized source page. */
  canonicalUrl: string;
  /** Public game delivery URL (e.g. game iframe src), if discovered. */
  gameUrl?: string;
  /** Entry HTML URL for engine detection/import (frame or canonical page). */
  entryUrl?: string;
  /** Absolute http(s) asset URLs exposed to the browser. Hints only. */
  assetUrls: string[];
  metadata?: {
    title?: string;
    thumbnail?: string;
  };
}

export interface GameSourceAdapter {
  readonly name: string;
  /** Pure, synchronous URL check. Must NOT perform network I/O. */
  canHandle(url: string): boolean;
  /**
   * Resolve an authorized source URL into a {@link ResolvedGameSource}.
   * Must validate SourcePolicy BEFORE fetching, preserve all SSRF
   * protections, revalidate every redirect, and never bypass
   * authentication, bot protection, access controls, DRM, or signed-URL
   * restrictions. Only plain fetches of public delivery configuration.
   */
  resolve(url: string, context: SourceContext): Promise<ResolvedGameSource>;
}

export class UnsupportedSourceLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSourceLayoutError';
  }
}

export class SourceAccessRestrictedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceAccessRestrictedError';
  }
}

export class SourceRedirectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceRedirectedError';
  }
}
