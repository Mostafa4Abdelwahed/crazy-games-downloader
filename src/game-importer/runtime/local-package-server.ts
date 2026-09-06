import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

export interface StartedPackageServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.data': 'application/octet-stream',
  '.unityweb': 'application/octet-stream',
  '.mem': 'application/octet-stream',
  '.br': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

export function contentTypeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.symbols.json')) return 'application/json';
  const ext = lower.slice(lower.lastIndexOf('.'));
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Local static file server for runtime validation (M3).
 *
 * Security rules:
 * - Binds 127.0.0.1 only (loopback). Any other host is refused.
 * - Serves ONLY files under the given package root (percent-decoded,
 *   normalized, containment-checked). No directory listings.
 * - GET/HEAD only. No .env-style special cases needed: confinement to the
 *   package directory means project files are unreachable by construction.
 * - Never `file://`: Unity WebGL requires http(s) origins (WASM MIME,
 *   fetch, workers).
 */
export class LocalPackageServer {
  async serve(
    rootDir: string,
    host = '127.0.0.1',
  ): Promise<StartedPackageServer> {
    if (host !== '127.0.0.1' && host !== 'localhost') {
      throw new Error(
        `Refusing to bind runtime server to non-loopback host: ${host}`,
      );
    }
    const root = path.resolve(rootDir);
    const rootStat = await fs.promises.stat(root).catch(() => null);
    if (!rootStat?.isDirectory()) {
      throw new Error(`Package root is not a directory: ${rootDir}`);
    }

    const server = http.createServer((req, res) => {
      void this.handle(req, res, root).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end('internal error');
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Failed to bind local package server');
    }
    return {
      url: `http://127.0.0.1:${address.port}/`,
      port: address.port,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    };
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    root: string,
  ): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    const rawPath = (req.url ?? '/').split('?')[0].split('#')[0];
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad request');
      return;
    }
    if (decoded.includes('\0')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad request');
      return;
    }
    // Map "/" to the entry file; never list directories.
    const rel = decoded === '/' ? '/index.html' : decoded;
    const abs = path.normalize(path.join(root, rel));
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentTypeForPath(abs),
      'Content-Length': stat.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(abs);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
  }
}
