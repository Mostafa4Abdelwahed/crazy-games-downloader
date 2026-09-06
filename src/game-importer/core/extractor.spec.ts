import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SecureExtractor } from './extractor';

function makeZip(entries: Record<string, string>): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    // addFile sanitizes names, so write a placeholder then overwrite the raw
    // entry name to simulate a real-world malicious archive crafted by
    // tools that preserve traversal/absolute paths.
    const placeholder = `__placeholder_${Math.random().toString(36).slice(2)}`;
    zip.addFile(placeholder, Buffer.from(content));
    const added = zip
      .getEntries()
      .find((e: any) => e.entryName === placeholder);
    added.entryName = name;
    added.header.fileNameLength = Buffer.byteLength(name);
  }
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ziptest-')),
    'a.zip',
  );
  zip.writeZip(p);
  return p;
}

describe('SecureExtractor archive protection', () => {
  it('extracts a benign archive', async () => {
    const ex = new SecureExtractor();
    const zip = makeZip({ 'Build/game.js': 'x', 'index.html': 'y' });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-'));
    const written = await ex.extractZip(zip, dest);
    expect(written.sort()).toEqual(['Build/game.js', 'index.html']);
  });

  it('blocks Zip Slip traversal entries', async () => {
    const ex = new SecureExtractor();
    const zip = makeZip({ '../evil.js': 'x', 'index.html': 'y' });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-'));
    await expect(ex.extractZip(zip, dest)).rejects.toThrow();
    expect(fs.existsSync(path.join(path.dirname(dest), 'evil.js'))).toBe(false);
  });

  it('blocks absolute paths', async () => {
    const ex = new SecureExtractor();
    const zip = makeZip({ '/tmp/evil.js': 'x' });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-'));
    await expect(ex.extractZip(zip, dest)).rejects.toThrow();
  });

  it('enforces file count limits', async () => {
    const ex = new SecureExtractor();
    const entries: Record<string, string> = {};
    for (let i = 0; i < 10; i++) entries[`f${i}.txt`] = 'x';
    const zip = makeZip(entries);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-'));
    await expect(
      ex.extractZip(zip, dest, {
        maxArchiveBytes: 10_000_000,
        maxExtractedBytes: 10_000_000,
        maxFileCount: 5,
        maxCompressionRatio: 100,
      }),
    ).rejects.toThrow(/count/i);
  });

  it('enforces archive size limits', async () => {
    const ex = new SecureExtractor();
    const zip = makeZip({ 'a.txt': 'x'.repeat(100) });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-'));
    await expect(
      ex.extractZip(zip, dest, {
        maxArchiveBytes: 1,
        maxExtractedBytes: 10_000_000,
        maxFileCount: 100,
        maxCompressionRatio: 100,
      }),
    ).rejects.toThrow(/too large/i);
  });
});
