import {
  formatBytes,
  renderFailureSummary,
  renderSuccessSummary,
  resolveValidateRealUrl,
} from './validate-real-summary';

describe('validate-real URL resolution', () => {
  it('prefers the CLI argument over the env var', () => {
    expect(
      resolveValidateRealUrl(
        ['node', 'validate-real.ts', 'https://example.com/game/a'],
        { REAL_TEST_SOURCE_URL: 'https://example.com/game/b' },
      ),
    ).toBe('https://example.com/game/a');
  });

  it('falls back to the env var without an argument', () => {
    expect(
      resolveValidateRealUrl(['node', 'validate-real.ts'], {
        REAL_TEST_SOURCE_URL: 'https://example.com/game/b',
      }),
    ).toBe('https://example.com/game/b');
  });

  it('returns null when neither is provided', () => {
    expect(resolveValidateRealUrl(['node', 'validate-real.ts'], {})).toBeNull();
    expect(
      resolveValidateRealUrl(['node', 'validate-real.ts', '   '], {}),
    ).toBeNull();
  });
});

describe('validate-real summary', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(96695283)).toBe('92.2 MB');
    expect(formatBytes(-1)).toBe('unknown size');
  });

  it('renders a success summary with the actual run values', () => {
    const rootPath =
      'C:\\Users\\H&M\\AppData\\Local\\Temp\\validate-real-dLkDpS\\job\\package';
    const out = renderSuccessSummary({
      rootPath,
      fileCount: 8,
      totalBytes: 96695283,
      engine: 'unity',
      runtimeCode: 'RUNTIME_OK',
    });
    expect(out).toContain('✅ Validation successful');
    expect(out).toContain(`Location: ${rootPath}`);
    expect(out).toContain('Files: 8');
    expect(out).toContain('92.2 MB');
    expect(out).toContain('Engine: unity');
    expect(out).toContain('Runtime: RUNTIME_OK');
    // PowerShell-safe: quoted cd handles spaces and `&`.
    expect(out).toContain(`cd "${rootPath}"`);
    expect(out).toContain('python -m http.server 8080');
    expect(out).toContain('http://localhost:8080');
    expect(out).toContain('file://');
    expect(out).toContain('DevTools (F12)');
  });

  it('renders a failure summary with the package path when generated', () => {
    const out = renderFailureSummary('C:\\tmp\\x\\job\\package');
    expect(out).toContain('❌ Validation failed');
    expect(out).toContain('C:\\tmp\\x\\job\\package');
  });

  it('renders a failure summary without a fake path when none exists', () => {
    const out = renderFailureSummary(null);
    expect(out).toContain('❌ Validation failed');
    expect(out).not.toContain('job\\package');
  });
});
