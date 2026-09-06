import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizePackagePath } from '../core/path-utils';
import { GameStorage } from './storage.interface';

/**
 * Local filesystem storage. Copies the validated package directory into
 * STORAGE_LOCAL_ROOT/<destination>/ after re-validating every relative path.
 */
@Injectable()
export class LocalStorage implements GameStorage {
  private readonly root: string;

  constructor() {
    this.root = process.env.STORAGE_LOCAL_ROOT ?? './data/packages';
  }

  async upload(localPath: string, destination: string): Promise<string> {
    const destSafe = destination
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .map((seg) => {
        if (seg === '..' || seg === '.') throw new Error('Invalid destination');
        if (/[^a-zA-Z0-9._-]/.test(seg)) {
          throw new Error(`Invalid destination segment: ${seg}`);
        }
        return seg;
      })
      .join('/');
    if (!destSafe) throw new Error('Empty destination');
    const destRoot = path.resolve(this.root, ...destSafe.split('/'));
    const rootNorm = path.resolve(this.root);
    if (destRoot !== rootNorm && !destRoot.startsWith(rootNorm + path.sep)) {
      throw new Error('Destination escapes storage root');
    }
    await fs.promises.mkdir(destRoot, { recursive: true });
    const entries = await this.walk(localPath);
    for (const abs of entries) {
      const rel = path.relative(localPath, abs).replace(/\\/g, '/');
      const safe = normalizePackagePath(rel); // re-validate before storage
      const dest = path.join(destRoot, ...safe.split('/'));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(abs, dest);
    }
    return destRoot;
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    const items = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const it of items) {
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) out.push(...(await this.walk(abs)));
      else if (it.isFile()) out.push(abs);
    }
    return out;
  }
}
