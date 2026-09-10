/**
 * Core domain types for the Game Importer.
 * All engines implement {@link GameEngineImporter} (dependency inversion).
 */

export type ImportState =
  | 'queued'
  | 'detecting'
  | 'resolving'
  | 'downloading'
  | 'extracting'
  | 'validating'
  | 'uploading'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Manual admin verdict on an imported game, independent of the pipeline
 * `ImportState`. After reviewing a finished game the admin marks it
 * `approved` (working) or `rejected` (broken); untouched jobs stay
 * `pending`. Never written by the import pipeline itself.
 */
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface DetectionSignal {
  name: string;
  weight: number;
  matched: boolean;
  detail?: string;
}

export interface DetectionContext {
  /** Canonical (post-redirect, SSRF-validated) source URL. */
  sourceUrl: string;
  /** Fetched HTML of the entry page (if any). Never executed. */
  html?: string;
  /**
   * Optional portal/wrapper page HTML containing delivery configuration.
   * Checked as a secondary source for engine detection signals when the
   * entry HTML alone is insufficient (e.g. JS-bootstrapped Unity frames).
   */
  portalHtml?: string;
  /** Final URL after redirects. */
  finalUrl?: string;
  /** Content-Type of entry response. */
  contentType?: string;
  /** Map of relative URL -> { status, contentType, bytes? } from lightweight probes. */
  probes?: Record<string, ProbeResult>;
  /** Filenames observed at the source (directory listing, archive entries, hints). */
  fileNames?: string[];
}

export interface ProbeResult {
  status: number;
  contentType?: string;
  bytes?: Buffer;
}

export interface DetectionResult {
  engine: string;
  confidence: number;
  signals: DetectionSignal[];
}

export interface ImportContext {
  jobId: string;
  sourceUrl: string;
  workDir: string;
  limits: ImportLimits;
  onProgress?: (update: ProgressUpdate) => Promise<void> | void;
  /**
   * Optional platform-agnostic source resolution (M2.5). Engine importers
   * may use `entryUrl` as the fetch base and `assetUrls` as download hints.
   * Never carries source-specific structures.
   */
  resolvedSource?: import('../sources/source.interface').ResolvedGameSource;
  /**
   * Optional diagnostics sink (M3). Engine importers report stable coded
   * events here; the worker persists them on the job. Additive — importers
   * that do not report simply never call it.
   */
  collectDiagnostics?: (d: import('./diagnostics').ImportDiagnostic) => void;
}

export interface ProgressUpdate {
  status?: ImportState;
  progress?: number;
  currentStep?: string;
  downloadedFiles?: number;
  totalFiles?: number;
  detectedEngine?: string;
}

export interface ImportLimits {
  timeoutMs: number;
  maxDownloadBytes: number;
  maxExtractedBytes: number;
  maxArchiveBytes: number;
  maxFileCount: number;
  maxCompressionRatio: number;
  maxMemoryMb: number;
  maxDiskMb: number;
}

export function defaultImportLimits(): ImportLimits {
  return {
    timeoutMs: Number(process.env.IMPORT_JOB_TIMEOUT_MS ?? 600_000),
    maxDownloadBytes: Number(
      process.env.IMPORT_MAX_DOWNLOAD_BYTES ?? 512 * 1024 * 1024,
    ),
    maxExtractedBytes: Number(
      process.env.IMPORT_MAX_EXTRACTED_BYTES ?? 1024 * 1024 * 1024,
    ),
    maxArchiveBytes: Number(
      process.env.IMPORT_MAX_DOWNLOAD_BYTES ?? 512 * 1024 * 1024,
    ),
    maxFileCount: 5000,
    maxCompressionRatio: 100,
    maxMemoryMb: Number(process.env.WORKER_MAX_MEMORY_MB ?? 1024),
    maxDiskMb: Number(process.env.WORKER_MAX_DISK_MB ?? 2048),
  };
}

export interface GameManifest {
  name: string;
  engine: string;
  engineVersion?: string;
  entryFile: string;
  createdAt: string;
  sourceUrl: string;
  fileCount: number;
  totalBytes: number;
  /** URL-safe package slug derived from the game name (M3). */
  slug?: string;
  /** Package schema version, currently "1" (M3). */
  version?: string;
  /** Origin platform info — never carries credentials or raw URLs (M3). */
  source?: {
    platform?: string;
  };
  /** Final package asset inventory, excluding manifest.json itself (M3). */
  assets?: Array<{ path: string; bytes: number; contentType?: string }>;
}

export interface GameFile {
  /** Normalized relative posix path inside the package, e.g. "Build/game.wasm". */
  path: string;
  bytes: number;
  contentType?: string;
}

export interface GamePackage {
  manifest: GameManifest;
  /** Absolute local path of the normalized package root. */
  rootPath: string;
  files: GameFile[];
}

export interface GameEngineImporter {
  name: string;
  detect(context: DetectionContext): Promise<DetectionResult>;
  import(context: ImportContext): Promise<GamePackage>;
}

export interface UnityBuild {
  loaderUrl: string;
  dataUrl?: string;
  frameworkUrl?: string;
  wasmCodeUrl?: string;
  codeUrl?: string;
  streamingAssetsUrl?: string;
  memoryUrl?: string;
  symbolsUrl?: string;
}

export interface ImportJob {
  id: string;
  /** Human-friendly sequential number (#1, #2, …) for the console. */
  seq?: number | null;
  sourceUrl: string;
  status: ImportState;
  /** Manual admin verdict; `pending` until the admin reviews the game. */
  reviewStatus: ReviewStatus;
  progress: number;
  detectedEngine?: string | null;
  downloadedFiles: number;
  totalFiles: number;
  currentStep?: string | null;
  error?: string | null;
  /** Stable failure code, e.g. RUNTIME_TIMEOUT (M3). Null unless failed. */
  errorCode?: string | null;
  /** Sanitized structured diagnostics (M3). */
  diagnostics?: import('./diagnostics').ImportDiagnostic[] | null;
  packageUrl?: string | null;
  /** On-disk size of the stored package (null when there is no package). */
  packageBytes?: number | null;
  /** File count inside the stored package (null when there is none). */
  packageFiles?: number | null;
  /** Owning folder id (organizational grouping). Null = ungrouped. */
  folderId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportJobLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  step?: string;
}
