import { UnityValidator } from './unity.validator';
import { GamePackage } from '../../core/types';

function pkg(files: string[]): GamePackage {
  return {
    manifest: {
      name: 'g',
      engine: 'unity',
      entryFile: 'index.html',
      createdAt: new Date().toISOString(),
      sourceUrl: 'https://partner.example/g',
      fileCount: files.length,
      totalBytes: files.length,
    },
    rootPath: '/tmp/pkg',
    files: files.map((p) => ({ path: p, bytes: 1 })),
  };
}

describe('UnityValidator', () => {
  const v = new UnityValidator();

  it('accepts a complete unity package', async () => {
    const r = await v.validate(
      pkg([
        'index.html',
        'Build/g.loader.js',
        'Build/g.framework.js',
        'Build/g.wasm',
        'Build/g.data',
      ]),
    );
    expect(r.valid).toBe(true);
  });

  it('rejects missing artifacts', async () => {
    const r = await v.validate(pkg(['index.html', 'Build/g.loader.js']));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/framework|wasm|data/);
  });

  it('rejects leftover .br files', async () => {
    const r = await v.validate(
      pkg([
        'index.html',
        'Build/g.loader.js',
        'Build/g.framework.js',
        'Build/g.wasm',
        'Build/g.data',
        'Build/g.wasm.br',
      ]),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/\.br/);
  });
});
