import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalPackageServer, contentTypeForPath } from './local-package-server';

describe('contentTypeForPath', () => {
  it('maps runtime-critical types', () => {
    expect(contentTypeForPath('Build/g.wasm')).toBe('application/wasm');
    expect(contentTypeForPath('Build/g.loader.js')).toBe('text/javascript');
    expect(contentTypeForPath('index.html')).toBe('text/html');
    expect(contentTypeForPath('Build/g.data')).toBe('application/octet-stream');
    expect(contentTypeForPath('x.unityweb')).toBe('application/octet-stream');
    expect(contentTypeForPath('x.unknown-ext')).toBe(
      'application/octet-stream',
    );
  });
});

describe('LocalPackageServer', () => {
  let root: string;
  let server: { url: string; port: number; close(): Promise<void> } | null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-server-'));
    fs.mkdirSync(path.join(root, 'Build'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<html>hi</html>');
    fs.writeFileSync(path.join(root, 'Build', 'g.wasm'), 'wasm-bytes');
    server = null;
  });

  afterEach(async () => {
    await server?.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('serves the package on loopback with correct MIME types', async () => {
    const srv = new LocalPackageServer();
    server = await srv.serve(root);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const index = await fetch(`${server.url}index.html`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html');
    expect(await index.text()).toBe('<html>hi</html>');

    const wasm = await fetch(`${server.url}Build/g.wasm`);
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get('content-type')).toBe('application/wasm');

    const head = await fetch(`${server.url}index.html`, { method: 'HEAD' });
    expect(head.status).toBe(200);
  });

  it('returns 404 for missing files and directories (no listing)', async () => {
    const srv = new LocalPackageServer();
    server = await srv.serve(root);
    expect((await fetch(`${server.url}nope.js`)).status).toBe(404);
    expect((await fetch(`${server.url}Build/`)).status).toBe(404);
  });

  it('answers 204 for the browser-chrome favicon request (no 404 noise)', async () => {
    const srv = new LocalPackageServer();
    server = await srv.serve(root);
    const res = await fetch(`${server.url}favicon.ico`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const head = await fetch(`${server.url}favicon.ico`, { method: 'HEAD' });
    expect(head.status).toBe(204);
  });

  it('still serves a real packaged favicon.ico as a file', async () => {
    fs.writeFileSync(path.join(root, 'favicon.ico'), 'icon-bytes');
    const srv = new LocalPackageServer();
    server = await srv.serve(root);
    const res = await fetch(`${server.url}favicon.ico`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('icon-bytes');
  });

  it('blocks path traversal including encoded variants', async () => {
    const srv = new LocalPackageServer();
    server = await srv.serve(root);
    for (const evil of [
      `${server.url}..%2f..%2fsecret.txt`,
      `${server.url}%2e%2e/%2e%2e/secret.txt`,
      `${server.url}..\\..\\secret.txt`,
    ]) {
      const res = await fetch(evil);
      expect([400, 403, 404]).toContain(res.status);
      expect(await res.text()).not.toContain('project-secret');
    }
  });

  it('cannot reach files outside the package root', async () => {
    const outside = path.join(os.tmpdir(), 'outside-server-test.txt');
    fs.writeFileSync(outside, 'project-secret');
    try {
      const srv = new LocalPackageServer();
      server = await srv.serve(root);
      const res = await fetch(`${server.url}../outside-server-test.txt`);
      expect(await res.text()).not.toContain('project-secret');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('rejects non-GET/HEAD methods and non-loopback binds', async () => {
    const srv = new LocalPackageServer();
    server = await srv.serve(root);
    const res = await fetch(`${server.url}index.html`, { method: 'POST' });
    expect(res.status).toBe(405);
    await expect(srv.serve(root, '0.0.0.0')).rejects.toThrow(/loopback/);
    await expect(srv.serve('/nonexistent-dir-xyz')).rejects.toThrow();
  });
});
