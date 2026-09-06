import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizePackagePath } from './path-utils';

export interface ExtractLimits {
  maxArchiveBytes: number;
  maxExtractedBytes: number;
  maxFileCount: number;
  maxCompressionRatio: number;
}

export function defaultExtractLimits(): ExtractLimits {
  return {
    maxArchiveBytes: Number(
      process.env.IMPORT_MAX_DOWNLOAD_BYTES ?? 512 * 1024 * 1024,
    ),
    maxExtractedBytes: Number(
      process.env.IMPORT_MAX_EXTRACTED_BYTES ?? 1024 * 1024 * 1024,
    ),
    maxFileCount: 5000,
    maxCompressionRatio: 100,
  };
}

// Lazy require so unit tests without adm-zip still typecheck; adm-zip is a dep.
function loadAdmZip(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('adm-zip');
  } catch {
    throw new Error('adm-zip dependency is required for archive extraction');
  }
}

/**
 * SecureExtractor guards against Zip Slip, absolute paths, oversized
 * archives, file-count bombs, and compression-ratio bombs.
 */
@Injectable()
export class SecureExtractor {
  async extractZip(
    zipPath: string,
    destDir: string,
    limits: ExtractLimits = defaultExtractLimits(),
  ): Promise<string[]> {
    const stat = await fs.promises.stat(zipPath);
    if (stat.size > limits.maxArchiveBytes) {
      throw new Error(
        `Archive too large: ${stat.size} > ${limits.maxArchiveBytes}`,
      );
    }
    const AdmZip = loadAdmZip();
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    if (entries.length > limits.maxFileCount) {
      throw new Error(`Archive file count ${entries.length} exceeds limit`);
    }
    await fs.promises.mkdir(destDir, { recursive: true });
    const written: string[] = [];
    let totalExtracted = 0;
    for (const entry of entries) {
      const rawName: string = entry.entryName;
      if (!rawName || rawName.endsWith('/')) continue;
      const safe = normalizePackagePath(rawName); // throws on traversal/absolute
      const compressed = entry.header.compressedSize ?? 0;
      const uncompressed = entry.header.size ?? 0;
      if (
        compressed > 0 &&
        uncompressed / Math.max(1, compressed) > limits.maxCompressionRatio
      ) {
        throw new Error(
          `Suspicious compression ratio for ${safe}: ${uncompressed}/${compressed}`,
        );
      }
      totalExtracted += uncompressed;
      if (totalExtracted > limits.maxExtractedBytes) {
        throw new Error('Extracted size exceeds limit');
      }
      if (written.length + 1 > limits.maxFileCount) {
        throw new Error('Extracted file count exceeds limit');
      }
      const abs = path.join(destDir, ...safe.split('/'));
      const destNorm = path.normalize(destDir);
      const absNorm = path.normalize(abs);
      if (absNorm !== destNorm && !absNorm.startsWith(destNorm + path.sep)) {
        throw new Error(`Path escapes destination: ${rawName}`);
      }
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      const data: Buffer = entry.getData();
      totalExtracted -= uncompressed;
      totalExtracted += data.length;
      if (totalExtracted > limits.maxExtractedBytes) {
        throw new Error('Extracted size exceeds limit');
      }
      await fs.promises.writeFile(abs, data);
      written.push(safe);
    }
    return written;
  }
}
