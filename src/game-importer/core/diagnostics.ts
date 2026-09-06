/**
 * Structured import diagnostics (M3).
 *
 * Stable machine-readable codes accompany every pipeline stage so failures
 * can be reported as `{ status, code, message, diagnostics }` without
 * leaking secrets. Human-readable `message`s are safe to surface; `details`
 * are sanitized at collection time (see {@link sanitizeDetail}).
 */
export type DiagnosticLevel = 'info' | 'warning' | 'error';

export interface ImportDiagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Stable diagnostic/error codes used across importer, validator, runtime. */
export const DiagnosticCode = {
  UNITY_LOADER_FOUND: 'UNITY_LOADER_FOUND',
  UNITY_BUILD_CONFIG_FOUND: 'UNITY_BUILD_CONFIG_FOUND',
  UNITY_DATA_RESOLVED: 'UNITY_DATA_RESOLVED',
  UNITY_FRAMEWORK_RESOLVED: 'UNITY_FRAMEWORK_RESOLVED',
  UNITY_WASM_RESOLVED: 'UNITY_WASM_RESOLVED',
  UNITY_CONFIG_NOT_FOUND: 'UNITY_CONFIG_NOT_FOUND',
  UNITY_LOADER_NOT_FOUND: 'UNITY_LOADER_NOT_FOUND',
  UNITY_CONFIG_DISCOVERY_STARTED: 'UNITY_CONFIG_DISCOVERY_STARTED',
  UNITY_CONFIG_FROM_LOADER: 'UNITY_CONFIG_FROM_LOADER',
  UNITY_CONFIG_FROM_CALLER: 'UNITY_CONFIG_FROM_CALLER',
  UNITY_CONFIG_FROM_EXTERNAL_RESOURCE: 'UNITY_CONFIG_FROM_EXTERNAL_RESOURCE',
  UNITY_CONFIG_FROM_ADAPTER_HINTS: 'UNITY_CONFIG_FROM_ADAPTER_HINTS',
  UNITY_CREATE_INSTANCE_FOUND: 'UNITY_CREATE_INSTANCE_FOUND',
  UNITY_CONFIG_VARIABLE_RESOLVED: 'UNITY_CONFIG_VARIABLE_RESOLVED',
  UNITY_ASSET_URL_RESOLVED: 'UNITY_ASSET_URL_RESOLVED',
  UNITY_ENTRY_BOOTSTRAP_GENERATED: 'UNITY_ENTRY_BOOTSTRAP_GENERATED',
  BROTLI_DECOMPRESSED: 'BROTLI_DECOMPRESSED',
  DECOMPRESSION_FAILED: 'DECOMPRESSION_FAILED',
  ASSET_DOWNLOADED: 'ASSET_DOWNLOADED',
  PACKAGE_VALID: 'PACKAGE_VALID',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  MISSING_ASSET: 'MISSING_ASSET',
  CORRUPT_ASSET: 'CORRUPT_ASSET',
  INVALID_REFERENCE: 'INVALID_REFERENCE',
  INVALID_CONTENT_TYPE: 'INVALID_CONTENT_TYPE',
  EXTERNAL_REFERENCE: 'EXTERNAL_REFERENCE',
  NETWORK_FAILURE: 'NETWORK_FAILURE',
  RUNTIME_OK: 'RUNTIME_OK',
  RUNTIME_ERROR: 'RUNTIME_ERROR',
  RUNTIME_TIMEOUT: 'RUNTIME_TIMEOUT',
  RUNTIME_CONSOLE_ERROR: 'RUNTIME_CONSOLE_ERROR',
  IMPORT_FAILED: 'IMPORT_FAILED',
} as const;

export type DiagnosticCodeValue =
  (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

/**
 * Coded error thrown by pipeline stages. The worker maps `code` onto the
 * job's `errorCode` and keeps `message` user-safe.
 */
export class ImportError extends Error {
  readonly code: string;
  readonly diagnostics: ImportDiagnostic[];

  constructor(
    code: string,
    message: string,
    diagnostics: ImportDiagnostic[] = [],
  ) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|session|credential|sig(nature)?|auth/i;

const MAX_DETAIL_STRING = 500;
const MAX_DIAGNOSTICS = 200;

/**
 * Strip query strings / fragments from a URL for log-safe output.
 * Returns `protocol//host/path` (truncated). Never throws.
 */
export function safeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    const path =
      u.pathname.length > 200 ? `${u.pathname.slice(0, 200)}…` : u.pathname;
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return String(raw).slice(0, 200);
  }
}

/** Recursively sanitize a details object: redact secrets, cap sizes. */
export function sanitizeDetail(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Redact embedded credentials / tokens in URLs and query strings.
    const redacted = value
      .replace(
        /([?&](token|sig|signature|key|auth|session)[^=]*=)[^&\s]*/gi,
        '$1[redacted]',
      )
      .replace(/(authorization:\s*)\S+/gi, '$1[redacted]');
    return redacted.length > MAX_DETAIL_STRING
      ? `${redacted.slice(0, MAX_DETAIL_STRING)}…`
      : redacted;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizeDetail(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[redacted]';
      } else if (/url|href|src|path|file/i.test(k) && typeof v === 'string') {
        out[k] = safeUrlForLog(v);
      } else {
        out[k] = sanitizeDetail(v, depth + 1);
      }
    }
    return out;
  }
  return '[unserializable]';
}

/** Accumulates sanitized diagnostics for a single import/validation run. */
export class DiagnosticCollector {
  private readonly items: ImportDiagnostic[] = [];

  add(
    level: DiagnosticLevel,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (this.items.length >= MAX_DIAGNOSTICS) return;
    this.items.push({
      level,
      code,
      message,
      ...(details
        ? { details: sanitizeDetail(details) as Record<string, unknown> }
        : {}),
    });
  }

  info(code: string, message: string, details?: Record<string, unknown>): void {
    this.add('info', code, message, details);
  }

  warning(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.add('warning', code, message, details);
  }

  error(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.add('error', code, message, details);
  }

  all(): ImportDiagnostic[] {
    return [...this.items];
  }

  hasErrors(): boolean {
    return this.items.some((d) => d.level === 'error');
  }
}

/** Extract a stable code + diagnostics from any thrown value (nest-safe). */
export function codeOfError(err: unknown, fallback: string): string {
  if (err instanceof ImportError) return err.code;
  return fallback;
}

export function diagnosticsOfError(err: unknown): ImportDiagnostic[] {
  if (err instanceof ImportError) return err.diagnostics;
  return [];
}
