import { normalizePackagePath, joinPackageRoot } from './path-utils';

describe('path normalization', () => {
  it('normalizes posix paths', () => {
    expect(normalizePackagePath('Build/game.wasm')).toBe('Build/game.wasm');
    expect(normalizePackagePath('./Build/./game.wasm')).toBe('Build/game.wasm');
  });

  it('converts windows separators', () => {
    expect(normalizePackagePath('Build\\game.wasm')).toBe('Build/game.wasm');
  });

  it('rejects traversal', () => {
    expect(() => normalizePackagePath('../evil.js')).toThrow();
    expect(() => normalizePackagePath('Build/../../evil.js')).toThrow();
  });

  it('rejects absolute paths', () => {
    expect(() => normalizePackagePath('/etc/passwd')).toThrow();
    expect(() => normalizePackagePath('C:\\Windows\\x')).toThrow();
  });

  it('joinPackageRoot stays contained', () => {
    const joined = joinPackageRoot('/tmp/root', 'Build/a.js');
    expect(joined).toContain('root');
    expect(() => joinPackageRoot('/tmp/root', '../evil')).toThrow();
  });
});
