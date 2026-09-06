import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { DiagnosticCode } from '../../core/diagnostics';
import { UnityDecompressor } from './unity.decompressor';

const compress = promisify(zlib.brotliCompress);

describe('UnityDecompressor transport decoding (M3.1)', () => {
  const d = new UnityDecompressor();

  it('passes non-.br files through untouched', async () => {
    const out = await d.decompressIfNeeded(
      Buffer.from('plain'),
      'game.wasm',
      'br',
    );
    expect(out.bytes.toString()).toBe('plain');
    expect(out.alreadyPlain).toBe(false);
  });

  it('decompresses real Brotli bytes', async () => {
    const original = Buffer.from('wasm-bytes'.repeat(100));
    const out = await d.decompressIfNeeded(
      await compress(original),
      'game.wasm.br',
    );
    expect(out.bytes.equals(original)).toBe(true);
    expect(out.alreadyPlain).toBe(false);
  });

  it('accepts transport-decoded wasm by magic', async () => {
    const plain = Buffer.concat([
      Buffer.from([0x00, 0x61, 0x73, 0x6d]),
      Buffer.from('rest-of-wasm'),
    ]);
    const out = await d.decompressIfNeeded(plain, 'game.wasm.br', 'br');
    expect(out.bytes.equals(plain)).toBe(true);
    expect(out.alreadyPlain).toBe(true);
  });

  it('accepts transport-decoded data by magic without header signal', async () => {
    const plain = Buffer.from('UnityWebData1.0\0payload');
    const out = await d.decompressIfNeeded(plain, 'game.data.br');
    expect(out.bytes.equals(plain)).toBe(true);
    expect(out.alreadyPlain).toBe(true);
  });

  it('accepts transport-decoded framework.js on protocol evidence', async () => {
    const plain = Buffer.from('var UnityFramework = {};');
    const out = await d.decompressIfNeeded(plain, 'game.framework.js.br', 'br');
    expect(out.bytes.equals(plain)).toBe(true);
    expect(out.alreadyPlain).toBe(true);
  });

  it('fails closed on HTML error pages masquerading as .br', async () => {
    const html = Buffer.from(
      '<html><body><h1>Access Denied</h1></body></html>',
    );
    await expect(
      d.decompressIfNeeded(html, 'game.wasm.br'),
    ).rejects.toMatchObject({ code: DiagnosticCode.DECOMPRESSION_FAILED });
    // Even WITH a transport header, HTML never matches wasm/data magic...
    await expect(
      d.decompressIfNeeded(html, 'game.wasm.br', 'br'),
    ).rejects.toMatchObject({ code: DiagnosticCode.DECOMPRESSION_FAILED });
  });

  it('fails closed on corrupt Brotli without any positive evidence', async () => {
    const garbage = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    await expect(
      d.decompressIfNeeded(garbage, 'game.data.br'),
    ).rejects.toMatchObject({ code: DiagnosticCode.DECOMPRESSION_FAILED });
  });

  it('fails closed on framework.js without transport evidence', async () => {
    // Plain JS that is NOT valid Brotli and has no header signal: an HTML
    // error page would look the same, so refuse rather than sniff JS.
    const plain = Buffer.from('var UnityFramework = {};');
    await expect(
      d.decompressIfNeeded(plain, 'game.framework.js.br'),
    ).rejects.toMatchObject({ code: DiagnosticCode.DECOMPRESSION_FAILED });
  });
});
