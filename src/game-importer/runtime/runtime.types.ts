import { GamePackage } from '../core/types';
import { ImportDiagnostic } from '../core/diagnostics';

/** Unity build artifact kinds tracked during runtime validation. */
export type RuntimeAssetKind =
  'loader' | 'framework' | 'wasm' | 'data' | 'other';

export interface FailedRuntimeRequest {
  url: string;
  method?: string;
  status?: number;
  errorText?: string;
}

export interface ExternalRuntimeRequest {
  url: string;
  method?: string;
}

/** Point-in-time init evidence gathered from the page + network. */
export interface InitSnapshot {
  canvasPresent: boolean;
  /** Artifact kinds observed with HTTP 200. */
  loadedKinds: RuntimeAssetKind[];
  /** Artifact kinds for which any request was observed. */
  attemptedKinds: RuntimeAssetKind[];
  /** Explicit ready flag set by the game (e.g. window.unityInitialized). */
  explicitReady: boolean;
  /** A Unity-flavored "initialized/ready" console message was seen. */
  consolePatternMatched: boolean;
  /** Uncaught page exceptions (fatal). */
  fatalErrors: string[];
  /** Failed requests for Unity runtime artifacts. */
  failedRequired: FailedRuntimeRequest[];
}

export interface InitEvaluation {
  initialized: boolean;
  matchedSignals: string[];
  missingSignals: string[];
}

export interface RuntimeValidationOptions {
  /** Overall timeout in ms (env RUNTIME_VALIDATION_TIMEOUT_MS, default 30000). */
  timeoutMs?: number;
  /** Poll interval in ms for init signals (default 250). */
  pollIntervalMs?: number;
  /** Record-but-block external requests (default false: record only). */
  blockExternal?: boolean;
  /** Explicit chromium executable (env PLAYWRIGHT_EXECUTABLE_PATH). */
  executablePath?: string;
  /** Entry file inside the package (defaults to manifest.entryFile). */
  entryFile?: string;
}

export interface RuntimeValidationResult {
  success: boolean;
  /** Stable result code: RUNTIME_OK, RUNTIME_ERROR, RUNTIME_TIMEOUT. */
  code: string;
  durationMs: number;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: FailedRuntimeRequest[];
  externalRequests: ExternalRuntimeRequest[];
  unityInitialized: boolean;
  /** Signal breakdown behind the verdict. */
  signals: InitEvaluation;
  diagnostics: ImportDiagnostic[];
}

export interface RuntimeValidationInput {
  pkg: GamePackage;
  options?: RuntimeValidationOptions;
}
