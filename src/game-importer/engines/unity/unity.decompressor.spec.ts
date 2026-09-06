import * as zlib from 'node:zlib';
import { UnityDecompressor } from './unity.decompressor';

describe('UnityDecompressor', () => {
  const d = new UnityDecompressor();

  it('detects .br by suffix', () => {
    expect(d.isBrotliFile('game.wasm.br')).toBe(true);
    expect(d.isBrotliFile('game.wasm')).toBe(false);
  });

  it('round-trips brotli data', async () => {
    const original = Buffer.from('unity-wasm-bytes'.repeat(100));
    const compressed: Buffer = await new Promise((res, rej) =>
      zlib.brotliCompress(original, (e, r) => (e ? rej(e) : res(r as Buffer))),
    );
    const out = await d.decompressBuffer(compressed);
    expect(out.equals(original)).toBe(true);
  });

  it('strips .br suffix', () => {
    expect(d.stripBrSuffix('game.data.br')).toBe('game.data');
    expect(d.stripBrSuffix('game.data')).toBe('game.data');
  });
});
