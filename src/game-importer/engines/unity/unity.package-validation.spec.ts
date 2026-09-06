import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GamePackage } from '../../core/types';
import { DiagnosticCode } from '../../core/diagnostics';
import { UnityValidator } from './unity.validator';

const LOADER = 'Build/g.loader.js';
const FRAMEWORK = 'Build/g.framework.js';
const WASM = 'Build/g.wasm';
const DATA = 'Build/g.data';

/** Build an in-memory package (no disk) with explicit metadata. */
function memPkg(
  files: Array<{ path: string; bytes?: number; contentType?: string }>,
  manifestExtra: Record<string, unknown> = {},
): GamePackage {
  const list = files.map((f) => ({
    path: f.path,
    bytes: f.bytes ?? 10,
    ...(f.contentType ? { contentType: f.contentType } : {}),
  }));
  return {
    manifest: {
      name: 'g',
      engine: 'unity',
      entryFile: 'index.html',
      createdAt: new Date().toISOString(),
      sourceUrl: 'https://partner.example/g',
      fileCount: list.length,
      totalBytes: list.reduce((a, f) => a + f.bytes, 0),
      ...manifestExtra,
    } as GamePackage['manifest'],
    rootPath: '/tmp/unity-validator-virtual-pkg',
    files: list,
  };
}

/** Materialize a package on disk under a temp dir. */
function diskPkg(
  files: Record<string, string>,
  manifestExtra: Record<string, unknown> = {},
): GamePackage {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-val-'));
  const list: GamePackage['files'] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    list.push({
      path: rel,
      bytes: Buffer.byteLength(content),
      contentType: contentTypeFor(rel),
    });
  }
  return {
    manifest: {
      name: 'g',
      engine: 'unity',
      entryFile: 'index.html',
      createdAt: new Date().toISOString(),
      sourceUrl: 'https://partner.example/g',
      fileCount: list.length,
      totalBytes: list.reduce((a, f) => a + f.bytes, 0),
      assets: list.map((f) => ({ ...f })),
      ...manifestExtra,
    } as GamePackage['manifest'],
    rootPath: root,
    files: list,
  };
}

const FULL = [LOADER, FRAMEWORK, WASM, DATA].map((p) => ({ path: p }));

function contentTypeFor(rel: string): string {
  if (rel.endsWith('.html')) return 'text/html';
  if (rel.endsWith('.js')) return 'text/javascript';
  if (rel.endsWith('.wasm')) return 'application/wasm';
  if (rel.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

describe('Unity package validation (M3)', () => {
  const v = new UnityValidator();

  it('accepts a valid Unity package with manifest inventory', async () => {
    const pkg = diskPkg({
      'index.html': `<html><body><script src="${LOADER}"></script></body></html>`,
      [LOADER]: 'loader',
      [FRAMEWORK]: 'framework',
      [WASM]: 'wasm-bytes',
      [DATA]: 'data-bytes',
      'manifest.json': '{}',
    });
    const r = await v.validateDetailed(pkg);
    expect(r.valid).toBe(true);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.PACKAGE_VALID,
    );
  });

  it('does not require build files absent from the manifest inventory', async () => {
    // A build that ships no .data: inventory-driven requirements only.
    const pkg = memPkg(
      [
        { path: 'index.html' },
        { path: LOADER },
        { path: FRAMEWORK },
        { path: WASM },
      ],
      {
        assets: [
          { path: 'index.html', bytes: 10 },
          { path: LOADER, bytes: 10 },
          { path: FRAMEWORK, bytes: 10 },
          { path: WASM, bytes: 10 },
        ],
      },
    );
    const r = await v.validateDetailed(pkg);
    expect(r.valid).toBe(true);
  });

  it('rejects a missing required asset', async () => {
    const r = await v.validateDetailed(
      memPkg([{ path: 'index.html' }, { path: LOADER }]),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/framework|wasm|data/);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.MISSING_ASSET,
    );
  });

  it('rejects invalid/traversal paths', async () => {
    const r = await v.validateDetailed(
      memPkg([
        { path: 'index.html' },
        { path: LOADER },
        { path: FRAMEWORK },
        { path: WASM },
        { path: DATA },
        { path: '../evil.js' },
      ]),
    );
    expect(r.valid).toBe(false);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.INVALID_REFERENCE,
    );
  });

  it('rejects corrupt (empty) assets', async () => {
    const r = await v.validateDetailed(
      memPkg([
        { path: 'index.html' },
        { path: LOADER },
        { path: FRAMEWORK },
        { path: WASM, bytes: 0 },
        { path: DATA },
      ]),
    );
    expect(r.valid).toBe(false);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.CORRUPT_ASSET,
    );
  });

  it('rejects wrong content types when declared', async () => {
    const r = await v.validateDetailed(
      memPkg([
        { path: 'index.html', contentType: 'text/html' },
        { path: LOADER, contentType: 'text/javascript' },
        { path: FRAMEWORK, contentType: 'text/javascript' },
        { path: WASM, contentType: 'text/html' },
        { path: DATA, contentType: 'application/octet-stream' },
      ]),
    );
    expect(r.valid).toBe(false);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.INVALID_CONTENT_TYPE,
    );
  });

  it('rejects an invalid manifest asset inventory', async () => {
    const pkg = memPkg(
      [
        { path: 'index.html' },
        { path: LOADER },
        { path: FRAMEWORK },
        { path: WASM },
        { path: DATA },
      ],
      { assets: [{ path: '../../etc/passwd', bytes: 1 }] },
    );
    const r = await v.validateDetailed(pkg);
    expect(r.valid).toBe(false);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.MANIFEST_INVALID,
    );
  });

  it('rejects entry references to missing runtime assets on disk', async () => {
    const pkg = diskPkg({
      'index.html': `<html><body><script src="${LOADER}"></script><script src="Build/missing.wasm"></script></body></html>`,
      [LOADER]: 'loader',
      [FRAMEWORK]: 'framework',
      [WASM]: 'wasm',
      [DATA]: 'data',
      'manifest.json': '{}',
    });
    const r = await v.validateDetailed(pkg);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/missing\.wasm/);
  });

  it('errors on external loader references, warns on other externals', async () => {
    const pkg = diskPkg({
      'index.html': `<html><body><script src="https://cdn.example/evil.loader.js"></script></body></html>`,
      [FRAMEWORK]: 'framework',
      [WASM]: 'wasm',
      [DATA]: 'data',
      'manifest.json': '{}',
    });
    const r = await v.validateDetailed(pkg);
    expect(r.valid).toBe(false);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.EXTERNAL_REFERENCE,
    );

    const pkg2 = diskPkg({
      'index.html': `<html><body><script src="${LOADER}"></script><script src="https://analytics.example/a.js"></script></body></html>`,
      [LOADER]: 'loader',
      [FRAMEWORK]: 'framework',
      [WASM]: 'wasm',
      [DATA]: 'data',
      'manifest.json': '{}',
    });
    const r2 = await v.validateDetailed(pkg2);
    expect(r2.valid).toBe(true);
    expect(r2.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.EXTERNAL_REFERENCE,
    );
  });

  it('detects size mismatches on disk as corruption', async () => {
    const pkg = diskPkg({
      'index.html': `<html><body><script src="${LOADER}"></script></body></html>`,
      [LOADER]: 'loader-bytes',
      [FRAMEWORK]: 'framework',
      [WASM]: 'wasm',
      [DATA]: 'data',
      'manifest.json': '{}',
    });
    // Tamper with metadata after materializing.
    const loader = pkg.files.find((f) => f.path === LOADER);
    loader!.bytes = 999_999;
    pkg.manifest.totalBytes = pkg.files.reduce((a, f) => a + f.bytes, 0);
    const r = await v.validateDetailed(pkg);
    expect(r.valid).toBe(false);
    expect(r.diagnostics.map((d) => d.code)).toContain(
      DiagnosticCode.CORRUPT_ASSET,
    );
  });

  it('keeps the legacy {valid, errors} shape working', async () => {
    const r = await v.validate(memPkg([{ path: 'index.html' }, ...FULL]));
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
