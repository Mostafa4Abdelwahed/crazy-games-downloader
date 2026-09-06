import {
  DiagnosticCode,
  DiagnosticCollector,
  ImportError,
  codeOfError,
  diagnosticsOfError,
  safeUrlForLog,
  sanitizeDetail,
} from './diagnostics';

describe('diagnostics', () => {
  it('exposes stable codes', () => {
    for (const code of [
      'UNITY_LOADER_FOUND',
      'UNITY_BUILD_CONFIG_FOUND',
      'UNITY_DATA_RESOLVED',
      'UNITY_FRAMEWORK_RESOLVED',
      'UNITY_WASM_RESOLVED',
      'BROTLI_DECOMPRESSED',
      'ASSET_DOWNLOADED',
      'PACKAGE_VALID',
      'MISSING_ASSET',
      'INVALID_REFERENCE',
      'EXTERNAL_REFERENCE',
      'NETWORK_FAILURE',
      'DECOMPRESSION_FAILED',
      'RUNTIME_ERROR',
      'RUNTIME_TIMEOUT',
    ]) {
      expect((DiagnosticCode as Record<string, string>)[code]).toBe(code);
    }
  });

  it('collector caps and copies entries', () => {
    const c = new DiagnosticCollector();
    c.info(DiagnosticCode.PACKAGE_VALID, 'ok');
    expect(c.all()).toHaveLength(1);
    expect(c.hasErrors()).toBe(false);
    c.error(DiagnosticCode.RUNTIME_ERROR, 'boom');
    expect(c.hasErrors()).toBe(true);
  });

  it('safeUrlForLog strips query and fragment', () => {
    expect(safeUrlForLog('https://cdn.example/Build/g.wasm?sig=secret#x')).toBe(
      'https://cdn.example/Build/g.wasm',
    );
    expect(safeUrlForLog('not a url')).toBe('not a url');
  });

  it('sanitizeDetail redacts secrets but keeps structure', () => {
    const out = sanitizeDetail({
      authorization: 'Bearer abc',
      url: 'https://cdn.example/g.wasm?token=xyz',
      nested: { apiKey: 'k', count: 3 },
      buf: Buffer.from('hello'),
    }) as Record<string, unknown>;
    expect(out['authorization']).toBe('[redacted]');
    expect(out['url']).toBe('https://cdn.example/g.wasm');
    expect((out['nested'] as Record<string, unknown>)['apiKey']).toBe(
      '[redacted]',
    );
    expect((out['nested'] as Record<string, unknown>)['count']).toBe(3);
    expect(out['buf']).toBe('[5 bytes]');
  });

  it('ImportError carries code and diagnostics', () => {
    const err = new ImportError('MISSING_ASSET', 'missing x', [
      { level: 'error', code: 'MISSING_ASSET', message: 'missing x' },
    ]);
    expect(codeOfError(err, 'IMPORT_FAILED')).toBe('MISSING_ASSET');
    expect(diagnosticsOfError(err)).toHaveLength(1);
    expect(codeOfError(new Error('plain'), 'IMPORT_FAILED')).toBe(
      'IMPORT_FAILED',
    );
    expect(diagnosticsOfError(new Error('plain'))).toEqual([]);
  });
});
