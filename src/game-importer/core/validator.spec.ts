import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PackageValidator } from './validator';
import { GamePackage } from './types';

function makePkg(
  rootPath: string,
  files: { path: string; bytes: number }[],
): GamePackage {
  const totalBytes = files.reduce((a, f) => a + f.bytes, 0);
  return {
    manifest: {
      name: 'g',
      engine: 'unity',
      entryFile: 'index.html',
      createdAt: new Date().toISOString(),
      sourceUrl: 'https://partner.example/g',
      fileCount: files.length,
      totalBytes,
    },
    rootPath,
    files: files.map((f) => ({
      ...f,
      contentType: 'application/octet-stream',
    })),
  };
}

describe('PackageValidator', () => {
  const v = new PackageValidator();

  it('accepts a coherent package', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgval-'));
    fs.mkdirSync(path.join(root, 'Build'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(root, 'Build', 'g.wasm'), 'wasm-bytes');
    const indexBytes = fs.statSync(path.join(root, 'index.html')).size;
    const wasmBytes = fs.statSync(path.join(root, 'Build', 'g.wasm')).size;
    const r = await v.validate(
      makePkg(root, [
        { path: 'index.html', bytes: indexBytes },
        { path: 'Build/g.wasm', bytes: wasmBytes },
      ]),
    );
    expect(r).toEqual({ valid: true, errors: [] });
  });

  it('rejects traversal paths and incoherent manifest', async () => {
    const bad: GamePackage = {
      manifest: {
        name: '',
        engine: '',
        entryFile: '../evil.html',
        createdAt: '',
        sourceUrl: '',
        fileCount: 99,
        totalBytes: 1,
      },
      rootPath: '/abs/pkg',
      files: [{ path: '../evil.js', bytes: 5 }],
    };
    const r = await v.validate(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});
