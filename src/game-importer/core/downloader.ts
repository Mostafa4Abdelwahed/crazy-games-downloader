import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertUrlSafe, validateRedirect, DnsResolver } from './ssrf';

export interface FetchResult {
  finalUrl: string;
  status: number;
  contentType?: string;
  /**
   * Transport content encoding as declared by the server (M3.1). Runtimes
   * like undici transparently decode `br`/`gzip` bodies, so a `.br` asset
   * may already arrive decompressed — the importer uses this signal
   * (plus content magic) to avoid double-decoding.
   */
  contentEncoding?: string;
  body: Buffer;
  redirected: boolean;
}

const MAX_REDIRECTS = 5;

/**
 * SecureDownloader fetches only http/https URLs with full SSRF protection,
 * redirect revalidation, size caps, and timeouts. Never executes JS.
 */
@Injectable()
export class SecureDownloader {
  async fetchText(
    url: string,
    opts?: { timeoutMs?: number; maxBytes?: number; resolver?: DnsResolver },
  ): Promise<FetchResult> {
    const res = await this.fetchBuffer(url, opts);
    return res;
  }

  async fetchBuffer(
    url: string,
    opts?: { timeoutMs?: number; maxBytes?: number; resolver?: DnsResolver },
  ): Promise<FetchResult> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const maxBytes =
      opts?.maxBytes ??
      Number(process.env.IMPORT_MAX_DOWNLOAD_BYTES ?? 512 * 1024 * 1024);
    let current = url;
    let redirected = false;
    await assertUrlSafe(current, opts?.resolver);

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      await assertUrlSafe(current, opts?.resolver);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetch(current, {
          signal: controller.signal,
          redirect: 'manual',
        });
      } finally {
        clearTimeout(timer);
      }
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const loc = resp.headers.get('location');
        if (!loc) throw new Error(`Redirect without location from ${current}`);
        current = await validateRedirect(current, loc, opts?.resolver);
        redirected = true;
        continue;
      }
      const contentType = resp.headers.get('content-type') ?? undefined;
      const contentEncoding = resp.headers.get('content-encoding') ?? undefined;
      if (!resp.ok) {
        throw new Error(`Fetch failed ${resp.status} for ${current}`);
      }
      const buf = await this.readBodyCapped(resp, maxBytes);
      return {
        finalUrl: current,
        status: resp.status,
        contentType,
        ...(contentEncoding ? { contentEncoding } : {}),
        body: buf,
        redirected,
      };
    }
    throw new Error('Too many redirects');
  }

  private async readBodyCapped(
    resp: Response,
    maxBytes: number,
  ): Promise<Buffer> {
    const reader = resp.body?.getReader();
    if (!reader) {
      const ab = await resp.arrayBuffer();
      if (ab.byteLength > maxBytes)
        throw new Error('Response exceeds size cap');
      return Buffer.from(ab);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error('Response exceeds size cap');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  async downloadToFile(
    url: string,
    destPath: string,
    opts?: { timeoutMs?: number; maxBytes?: number; resolver?: DnsResolver },
  ): Promise<{ finalUrl: string; bytes: number; contentType?: string }> {
    const res = await this.fetchBuffer(url, opts);
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.writeFile(destPath, res.body);
    return {
      finalUrl: res.finalUrl,
      bytes: res.body.length,
      contentType: res.contentType,
    };
  }
}
