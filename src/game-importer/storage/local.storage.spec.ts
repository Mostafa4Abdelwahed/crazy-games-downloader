import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalStorage } from './local.storage';

describe('LocalStorage abstraction', () => {
  it('uploads a directory and validates paths', async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgsrc-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgroot-'));
    fs.mkdirSync(path.join(src, 'Build'), { recursive: true });
    fs.writeFileSync(path.join(src, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(src, 'Build', 'g.wasm'), 'wasm');
    process.env.STORAGE_LOCAL_ROOT = root;
    const storage = new LocalStorage();
    const dest = await storage.upload(src, 'job-123');
    expect(fs.existsSync(path.join(dest, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'Build', 'g.wasm'))).toBe(true);
  });

  it('rejects destinations escaping the root', async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgsrc-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgroot-'));
    process.env.STORAGE_LOCAL_ROOT = root;
    const storage = new LocalStorage();
    await expect(storage.upload(src, '../escape')).rejects.toThrow();
  });
});
