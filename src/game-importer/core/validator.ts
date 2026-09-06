import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizePackagePath } from './path-utils';
import { GamePackage } from './types';

export interface PackageValidationResult {
  valid: boolean;
  errors: string[];
}

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

/**
 * PackageValidator checks the normalized GamePackage before storage:
 * entry file exists, all paths normalized & contained, manifest coherent,
 * no absolute/traversal paths, sizes sane.
 */
@Injectable()
export class PackageValidator {
  async validate(pkg: GamePackage): Promise<PackageValidationResult> {
    const errors: string[] = [];
    const { manifest, rootPath, files } = pkg;
    if (!manifest) errors.push('Missing manifest');
    if (!rootPath || !path.isAbsolute(rootPath)) {
      errors.push('rootPath must be absolute');
    }
    if (!Array.isArray(files) || files.length === 0) {
      errors.push('Package contains no files');
    }
    if (manifest) {
      if (!manifest.name) errors.push('manifest.name missing');
      if (!manifest.engine) errors.push('manifest.engine missing');
      if (!manifest.entryFile) errors.push('manifest.entryFile missing');
      else {
        try {
          const entry = normalizePackagePath(manifest.entryFile);
          const abs = path.join(rootPath, ...entry.split('/'));
          if (!fs.existsSync(abs)) {
            errors.push(`Entry file missing on disk: ${entry}`);
          }
        } catch (e) {
          errors.push(`Invalid entryFile: ${(e as Error).message}`);
        }
      }
    }
    const seen = new Set<string>();
    for (const f of files ?? []) {
      try {
        const safe = normalizePackagePath(f.path);
        if (safe !== f.path.replace(/\\/g, '/')) {
          errors.push(`Un-normalized path: ${f.path}`);
        }
        if (seen.has(safe)) errors.push(`Duplicate path: ${safe}`);
        seen.add(safe);
        const abs = path.join(rootPath, ...safe.split('/'));
        const rootNorm = path.normalize(rootPath);
        const absNorm = path.normalize(abs);
        if (absNorm !== rootNorm && !absNorm.startsWith(rootNorm + path.sep)) {
          errors.push(`Path escapes root: ${f.path}`);
        }
        if (f.bytes < 0 || f.bytes > MAX_FILE_BYTES) {
          errors.push(`Invalid byte size for ${safe}: ${f.bytes}`);
        }
      } catch (e) {
        errors.push(`Invalid path ${f.path}: ${(e as Error).message}`);
      }
    }
    if (manifest && files) {
      const total = files.reduce((a, f) => a + (f.bytes || 0), 0);
      if (manifest.totalBytes !== total) {
        errors.push(
          `manifest.totalBytes (${manifest.totalBytes}) != sum of files (${total})`,
        );
      }
      if (manifest.fileCount !== files.length) {
        errors.push(
          `manifest.fileCount (${manifest.fileCount}) != files length (${files.length})`,
        );
      }
    }
    void MAX_MANIFEST_BYTES;
    return { valid: errors.length === 0, errors };
  }
}
