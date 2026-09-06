import { Injectable } from '@nestjs/common';
import * as zlib from 'node:zlib';
import { DiagnosticCode, ImportError } from '../../core/diagnostics';

export interface DecompressOutcome {
  bytes: Buffer;
  /** True when the payload was already plain (transport-decoded). */
  alreadyPlain: boolean;
}

/** Strong Unity content magics used to verify transport-decoded payloads. */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const UNITY_DATA_MAGIC = 'UnityWebData';

/**
 * Brotli decompressor for supported .br Unity build artifacts
 * (e.g. game.wasm.br, game.data.br, game.framework.js.br).
 * Only decompresses when the source filename/bytes indicate brotli.
 */
@Injectable()
export class UnityDecompressor {
  isBrotliFile(fileName: string): boolean {
    return fileName.toLowerCase().endsWith('.br');
  }

  async decompressFile(
    inputPath: string,
    outputPath: string,
  ): Promise<{ bytes: number }> {
    const fs = await import('node:fs');
    const data = await fs.promises.readFile(inputPath);
    const out = await this.decompressBuffer(data);
    await fs.promises.mkdir((await import('node:path')).dirname(outputPath), {
      recursive: true,
    });
    await fs.promises.writeFile(outputPath, out);
    return { bytes: out.length };
  }

  async decompressBuffer(data: Buffer): Promise<Buffer> {
    return (await this.decompressIfNeeded(data, 'asset.br')).bytes;
  }

  /**
   * Decompress a `.br` payload, tolerating transport-decoded bodies (M3.1).
   * Real CDNs serve `.br` objects with `Content-Encoding: br`, which the
   * HTTP runtime transparently decodes — decompressing those bytes AGAIN
   * fails. Strategy: try Brotli first; on failure, accept the bytes
   * as-is ONLY with positive evidence (transport encoding signal and/or
   * strong Unity content magic). Anything else fails closed, since an
   * HTML error page must never be packaged as a build artifact.
   */
  async decompressIfNeeded(
    data: Buffer,
    fileName: string,
    contentEncoding?: string,
  ): Promise<DecompressOutcome> {
    if (!this.isBrotliFile(fileName)) {
      return { bytes: data, alreadyPlain: false };
    }
    try {
      const out = await this.decompressRaw(data);
      return { bytes: out, alreadyPlain: false };
    } catch (firstErr) {
      const transportDecoded =
        typeof contentEncoding === 'string' &&
        contentEncoding.length > 0 &&
        !/^\s*identity\s*$/i.test(contentEncoding);
      const target = this.stripBrSuffix(fileName).toLowerCase();
      const magicOk =
        (target.endsWith('.wasm') && data.subarray(0, 4).equals(WASM_MAGIC)) ||
        (target.endsWith('.data') &&
          data.subarray(0, UNITY_DATA_MAGIC.length).toString('utf8') ===
            UNITY_DATA_MAGIC);
      // wasm/data: magic must match with or without a transport signal, so
      // an HTML error page can never pass. .js has no magic: accept only on
      // transport protocol evidence, never by sniffing.
      const protocolOk = transportDecoded && target.endsWith('.js');
      if (magicOk || protocolOk) {
        return { bytes: data, alreadyPlain: true };
      }
      throw new ImportError(
        DiagnosticCode.DECOMPRESSION_FAILED,
        `Brotli decompression failed: ${(firstErr as Error).message}`,
      );
    }
  }

  private decompressRaw(data: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      zlib.brotliDecompress(data, (err, result) => {
        if (err) reject(err);
        else resolve(result as Buffer);
      });
    });
  }

  stripBrSuffix(fileName: string): string {
    return fileName.toLowerCase().endsWith('.br')
      ? fileName.slice(0, -3)
      : fileName;
  }
}
