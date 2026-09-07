/**
 * Pure presentation helpers for `npm run validate:real` (M3.2).
 *
 * Kept side-effect free so the CLI summary formatting is unit-testable.
 * All paths rendered here must come from the actual run (`package.rootPath`
 * / runtime result) — never hardcoded.
 */

/**
 * Resolve the game URL for `validate:real` from an explicit CLI argument
 * first (`npm run validate:real -- <url>`), then the `REAL_TEST_SOURCE_URL`
 * env var (CI/back-compat). Returns null when neither is provided, in
 * which case the caller prompts interactively.
 */
export function resolveValidateRealUrl(
  argv: string[],
  env: Record<string, string | undefined>,
): string | null {
  const fromArg = (argv[2] ?? '').trim();
  if (fromArg) return fromArg;
  const fromEnv = (env['REAL_TEST_SOURCE_URL'] ?? '').trim();
  return fromEnv || null;
}

/** Human-readable byte size, e.g. `92.2 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (const u of units) {
    unit = u;
    if (value < 1024 || u === units[units.length - 1]) break;
    value /= 1024;
  }
  const rounded =
    value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

export interface ValidateRealSummaryInput {
  rootPath: string;
  fileCount: number;
  totalBytes: number;
  engine: string;
  runtimeCode: string;
}

/** Final success summary with copy-paste PowerShell run instructions. */
export function renderSuccessSummary(input: ValidateRealSummaryInput): string {
  const lines = [
    '✅ Validation successful',
    '',
    '📦 Package',
    `   Location: ${input.rootPath}`,
    `   Files: ${input.fileCount}`,
    `   Size: ${formatBytes(input.totalBytes)} (${input.totalBytes} bytes)`,
    `   Engine: ${input.engine}`,
    `   Runtime: ${input.runtimeCode}`,
    '',
    '🎮 Run the game locally',
    '',
    `cd "${input.rootPath}"`,
    'python -m http.server 8080',
    '',
    'Open in your browser:',
    'http://localhost:8080',
    '',
    'ℹ️ Serve the package over HTTP.',
    'Do not open index.html directly with file:// because Unity WebGL requires HTTP serving.',
    '',
    '🔍 Manual check',
    '',
    '1. Open http://localhost:8080',
    '2. Open DevTools (F12)',
    '3. Check Console and Network',
    '4. Verify there are no failed game asset requests',
  ];
  return lines.join('\n');
}

/**
 * Failure summary. The package location is printed only when a package was
 * actually generated (useful for debugging); otherwise no path is shown.
 */
export function renderFailureSummary(rootPath: string | null): string {
  const lines = ['❌ Validation failed', ''];
  if (rootPath) {
    lines.push('📦 Generated package:', rootPath, '');
  }
  lines.push('Check the diagnostics above for the failure reason.');
  return lines.join('\n');
}
