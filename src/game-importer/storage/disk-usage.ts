import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DirUsage {
  bytes: number;
  files: number;
}

/**
 * Recursive on-disk usage of one directory (symlinks are not followed).
 * Missing/unreadable paths report zero — usage is informational, it must
 * never break the caller.
 */
export async function dirUsage(root: string): Promise<DirUsage> {
  const acc: DirUsage = { bytes: 0, files: 0 };
  let dir: fs.Dir;
  try {
    dir = await fs.promises.opendir(path.resolve(root));
  } catch {
    return acc;
  }
  try {
    for await (const entry of dir) {
      const abs = path.join(dir.path, entry.name);
      try {
        if (entry.isDirectory()) {
          const sub = await dirUsage(abs);
          acc.bytes += sub.bytes;
          acc.files += sub.files;
        } else if (entry.isFile()) {
          const st = await fs.promises.stat(abs);
          acc.bytes += st.size;
          acc.files += 1;
        }
      } catch {
        /* unreadable child: skip, keep the rest */
      }
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  return acc;
}
