import * as path from 'node:path';

/**
 * Normalize a package-relative path and reject unsafe paths.
 * - Rejects absolute paths, drive letters, null bytes
 * - Rejects `..` traversal escaping the package root
 * - Returns posix-style relative path
 */
export function normalizePackagePath(input: string): string {
  if (input.includes('\0')) throw new PathTraversalError('Null byte in path');
  // Backslashes -> forward slashes for zip entries authored on Windows
  let p = input.replace(/\\/g, '/').trim();
  // Strip leading ./ repeatedly
  while (p.startsWith('./')) p = p.slice(2);
  if (
    p.startsWith('/') ||
    /^[a-zA-Z]:/.test(p) ||
    p.startsWith('\\\\') ||
    p.includes(':')
  ) {
    // Allow colon only? No — reject to be safe (protocol/drive confusion).
    // But allow single colon inside filename? Keep strict: reject absolute/drive.
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
      throw new PathTraversalError(`Absolute path not allowed: ${input}`);
    }
  }
  const normalized = path.posix.normalize(p);
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new PathTraversalError(`Path traversal detected: ${input}`);
  }
  if (normalized === '.' || normalized === '') {
    throw new PathTraversalError(`Empty path: ${input}`);
  }
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === '..') {
      throw new PathTraversalError(`Path traversal detected: ${input}`);
    }
    if (part.length > 255) {
      throw new PathTraversalError(`Path segment too long: ${input}`);
    }
  }
  if (normalized.length > 1024) {
    throw new PathTraversalError(`Path too long: ${input}`);
  }
  return normalized;
}

/** Join a package-relative path onto an absolute root, verifying containment. */
export function joinPackageRoot(rootAbs: string, rel: string): string {
  const safe = normalizePackagePath(rel);
  const joined = path.posix.normalize(
    path.join(rootAbs, safe).replace(/\\/g, '/'),
  );
  const rootNorm = path.normalize(rootAbs);
  const joinedNorm = path.normalize(joined);
  if (joinedNorm !== rootNorm && !joinedNorm.startsWith(rootNorm + path.sep)) {
    throw new PathTraversalError(`Path escapes package root: ${rel}`);
  }
  return joined;
}

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

export function contentTypeForFile(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'html':
      return 'text/html';
    case 'js':
      return 'text/javascript';
    case 'mjs':
      return 'text/javascript';
    case 'wasm':
      return 'application/wasm';
    case 'data':
      return 'application/octet-stream';
    case 'json':
      return 'application/json';
    case 'css':
      return 'text/css';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'ico':
      return 'image/x-icon';
    case 'woff':
      return 'font/woff';
    case 'woff2':
      return 'font/woff2';
    case 'ttf':
      return 'font/ttf';
    case 'otf':
      return 'font/otf';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'txt':
      return 'text/plain';
    case 'unityweb':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}
