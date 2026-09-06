import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GamePackage } from '../../core/types';
import { normalizePackagePath } from '../../core/path-utils';
import {
  DiagnosticCode,
  DiagnosticCollector,
  DiagnosticLevel,
  ImportDiagnostic,
} from '../../core/diagnostics';

export interface UnityValidationResult {
  valid: boolean;
  errors: string[];
  diagnostics: ImportDiagnostic[];
}

/** Expected content types by file extension (strict when declared). */
const EXPECTED_CONTENT_TYPES: Record<string, string[]> = {
  '.js': ['text/javascript', 'application/javascript'],
  '.wasm': ['application/wasm'],
  '.html': ['text/html'],
  '.json': ['application/json'],
  '.css': ['text/css'],
  '.data': ['application/octet-stream', 'application/wasm'],
  '.symbols.json': ['application/json'],
};

function expectedTypes(filePath: string): string[] | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.symbols.json'))
    return EXPECTED_CONTENT_TYPES['.symbols.json'] ?? null;
  const ext = lower.slice(lower.lastIndexOf('.'));
  return EXPECTED_CONTENT_TYPES[ext] ?? null;
}

function artifactKind(
  filePath: string,
): 'loader' | 'framework' | 'wasm' | 'data' | 'other' {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.loader.js')) return 'loader';
  if (lower.endsWith('.framework.js')) return 'framework';
  if (lower.endsWith('.wasm')) return 'wasm';
  if (lower.endsWith('.data')) return 'data';
  return 'other';
}

/** True when a reference looks like a Unity runtime artifact. */
function isRuntimeArtifactRef(ref: string): boolean {
  return /\.(loader\.js|framework\.js|wasm|data|unityweb|symbols\.json)(\?|#|$)/i.test(
    ref,
  );
}

/**
 * Unity-specific package checks on top of the generic PackageValidator.
 *
 * Required runtime files are derived from the package manifest's asset
 * inventory when present (M3) — files the specific build does not use are
 * never blindly required. Without an inventory it falls back to the classic
 * loader + framework + wasm + data set. Metadata-only checks always run;
 * on-disk cross-checks (referenced assets exist, non-empty, size coherence)
 * run best-effort whenever `rootPath` exists, so in-memory packages remain
 * validatable.
 */
@Injectable()
export class UnityValidator {
  async validate(
    pkg: GamePackage,
  ): Promise<{ valid: boolean; errors: string[] }> {
    const r = await this.validateDetailed(pkg);
    return { valid: r.valid, errors: r.errors };
  }

  async validateDetailed(pkg: GamePackage): Promise<UnityValidationResult> {
    const collector = new DiagnosticCollector();
    const report = (
      level: DiagnosticLevel,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) => {
      collector.add(level, code, message, details);
    };
    const fail = (
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) => {
      report('error', code, message, details);
    };

    const files = pkg.files ?? [];
    const names = files.map((f) => f.path.toLowerCase());
    // Case-insensitive index: manifests and listings may differ in case.
    const byPath = new Map(
      files.map((f) => [f.path.replace(/\\/g, '/').toLowerCase(), f]),
    );

    // 1. Path safety for every listed file.
    for (const f of files) {
      try {
        normalizePackagePath(f.path);
      } catch (e) {
        fail(
          DiagnosticCode.INVALID_REFERENCE,
          `Unsafe path in package: ${f.path}`,
          { reason: (e as Error).message },
        );
      }
      if (typeof f.bytes !== 'number' || f.bytes < 0) {
        fail(DiagnosticCode.CORRUPT_ASSET, `Invalid byte size for ${f.path}`);
      } else if (f.bytes === 0) {
        fail(DiagnosticCode.CORRUPT_ASSET, `Empty asset: ${f.path}`);
      }
      if (f.contentType) {
        const expected = expectedTypes(f.path);
        if (expected && !expected.includes(f.contentType.toLowerCase())) {
          fail(
            DiagnosticCode.INVALID_CONTENT_TYPE,
            `Wrong content type for ${f.path}: ${f.contentType}`,
            { expected: expected.join(' or ') },
          );
        }
      }
    }

    // 2. Required artifacts: manifest inventory wins, else classic set.
    const inventory = pkg.manifest?.assets?.map((a) => a.path.toLowerCase());
    const kindsInInventory = inventory
      ? new Set(inventory.map((p) => artifactKind(p)))
      : null;
    const need = (kind: 'loader' | 'framework' | 'wasm' | 'data'): boolean => {
      if (kind === 'loader') return true;
      if (!kindsInInventory) return true;
      return kindsInInventory.has(kind);
    };
    const missing: string[] = [];
    if (need('loader') && !names.some((n) => n.endsWith('.loader.js'))) {
      missing.push('*.loader.js');
    }
    if (need('framework') && !names.some((n) => n.endsWith('.framework.js'))) {
      missing.push('*.framework.js');
    }
    if (need('wasm') && !names.some((n) => n.endsWith('.wasm'))) {
      missing.push('*.wasm');
    }
    if (need('data') && !names.some((n) => n.endsWith('.data'))) {
      missing.push('*.data');
    }
    for (const m of missing) {
      fail(DiagnosticCode.MISSING_ASSET, `Unity package missing ${m}`);
    }
    if (inventory) {
      for (const p of inventory) {
        if (!byPath.has(p.replace(/\\/g, '/'))) {
          fail(
            DiagnosticCode.MISSING_ASSET,
            `Manifest asset not in package: ${p}`,
          );
        }
      }
    }
    // 3. No undecompressed leftovers.
    const leftoverBr = names.filter((n) => n.endsWith('.br'));
    if (leftoverBr.length) {
      fail(
        DiagnosticCode.DECOMPRESSION_FAILED,
        `Undecompressed .br artifacts remain: ${leftoverBr.join(', ')}`,
      );
    }

    // 4. Entry file.
    const entryName = names.includes('index.html')
      ? 'index.html'
      : names.find((n) => n.endsWith('/index.html'));
    if (!entryName) {
      fail(
        DiagnosticCode.MISSING_ASSET,
        'Unity package missing index.html entry',
      );
    }

    // 5. Manifest sanity (unity-relevant subset; core validator owns the rest).
    if (pkg.manifest?.assets) {
      for (const a of pkg.manifest.assets) {
        try {
          normalizePackagePath(a.path);
        } catch (e) {
          fail(
            DiagnosticCode.MANIFEST_INVALID,
            `Manifest lists unsafe asset path: ${a.path}`,
            { reason: (e as Error).message },
          );
        }
      }
    }

    // 6. Best-effort on-disk cross-checks (skipped for virtual packages).
    if (pkg.rootPath && entryName && this.dirExists(pkg.rootPath)) {
      this.checkEntryReferences(pkg, entryName, byPath, report);
      this.checkFilesOnDisk(pkg, fail);
    }

    if (!collector.hasErrors()) {
      collector.info(
        DiagnosticCode.PACKAGE_VALID,
        'Unity package passed validation',
        { fileCount: files.length },
      );
    }
    const diagnostics = collector.all();
    return {
      valid: !collector.hasErrors(),
      errors: diagnostics
        .filter((d) => d.level === 'error')
        .map((d) => d.message),
      diagnostics,
    };
  }

  private dirExists(rootPath: string): boolean {
    try {
      return fs.statSync(rootPath).isDirectory();
    } catch {
      return false;
    }
  }

  /** Verify index.html's local refs exist in the package; flag externals. */
  private checkEntryReferences(
    pkg: GamePackage,
    entryName: string,
    byPath: Map<string, (typeof pkg.files)[number]>,
    report: (
      level: DiagnosticLevel,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) => void,
  ): void {
    let html: string;
    try {
      const abs = path.join(pkg.rootPath, ...entryName.split('/'));
      const rootNorm = path.normalize(pkg.rootPath);
      const absNorm = path.normalize(abs);
      if (absNorm !== rootNorm && !absNorm.startsWith(rootNorm + path.sep)) {
        return;
      }
      html = fs.readFileSync(abs, 'utf8').slice(0, 500_000);
    } catch {
      report(
        'error',
        DiagnosticCode.MISSING_ASSET,
        `Entry file unreadable: ${entryName}`,
      );
      return;
    }
    const refs = new Set<string>();
    for (const re of [
      /<script[^>]+src\s*=\s*["']([^"']+)["']/gi,
      /<link[^>]+href\s*=\s*["']([^"']+)["']/gi,
    ]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) refs.add(m[1].trim());
    }
    let loaderCovered = false;
    for (const ref of refs) {
      if (!ref || ref.startsWith('#')) continue;
      if (/^(data|blob|about|javascript):/i.test(ref)) continue;
      // Only Unity runtime artifacts are enforced strictly; auxiliary
      // references (favicons, stylesheets, analytics) warn instead of
      // failing, since real builds commonly reference files outside the
      // downloaded build set.
      const strict = isRuntimeArtifactRef(ref);
      const level: DiagnosticLevel = strict ? 'error' : 'warning';
      if (/^https?:\/\//i.test(ref)) {
        // Runtime-required local assets must not point at external origins.
        if (/\.loader\.js(\?|#|$)/i.test(ref)) {
          report(
            'error',
            DiagnosticCode.EXTERNAL_REFERENCE,
            `Loader must be packaged locally, found external reference: ${ref.slice(0, 120)}`,
          );
        } else {
          report(
            level === 'error' ? 'error' : 'warning',
            DiagnosticCode.EXTERNAL_REFERENCE,
            `External reference in ${entryName}: ${ref.slice(0, 120)}`,
          );
        }
        continue;
      }
      if (ref.startsWith('/') || ref.includes('..') || /^[a-zA-Z]:/.test(ref)) {
        report(
          level,
          DiagnosticCode.INVALID_REFERENCE,
          `Invalid local reference in ${entryName}: ${ref.slice(0, 120)}`,
        );
        continue;
      }
      const normalized = path.posix.normalize(ref);
      const hit =
        byPath.has(normalized.toLowerCase()) ||
        byPath.has(`build/${normalized.toLowerCase()}`);
      if (!hit) {
        // Resolve relative to the entry dir (package root here).
        report(
          level,
          DiagnosticCode.MISSING_ASSET,
          `Entry references missing asset: ${ref.slice(0, 120)}`,
        );
        continue;
      }
      if (/\.loader\.js$/i.test(normalized)) loaderCovered = true;
    }
    void loaderCovered;
  }

  /** Verify listed files exist on disk, are non-empty, sizes coherent. */
  private checkFilesOnDisk(
    pkg: GamePackage,
    fail: (
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) => void,
  ): void {
    const rootNorm = path.normalize(pkg.rootPath);
    for (const f of pkg.files) {
      let safe: string;
      try {
        safe = normalizePackagePath(f.path);
      } catch {
        continue; // already reported above
      }
      const abs = path.join(pkg.rootPath, ...safe.split('/'));
      const absNorm = path.normalize(abs);
      if (absNorm !== rootNorm && !absNorm.startsWith(rootNorm + path.sep)) {
        continue; // already reported above
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        fail(DiagnosticCode.MISSING_ASSET, `Asset missing on disk: ${safe}`);
        continue;
      }
      if (!st.isFile() || st.size === 0) {
        fail(DiagnosticCode.CORRUPT_ASSET, `Asset empty on disk: ${safe}`);
      } else if (st.size !== f.bytes) {
        fail(
          DiagnosticCode.CORRUPT_ASSET,
          `Asset size mismatch on disk: ${safe}`,
          { expected: f.bytes, actual: st.size },
        );
      }
    }
  }
}
