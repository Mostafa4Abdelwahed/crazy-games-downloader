import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dirUsage } from './disk-usage';

describe('dirUsage', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'du-'));
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('sums nested file sizes and counts files', async () => {
    await fs.promises.writeFile(path.join(root, 'a.bin'), Buffer.alloc(100));
    await fs.promises.mkdir(path.join(root, 'sub', 'deep'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(root, 'sub', 'b.bin'),
      Buffer.alloc(50),
    );
    await fs.promises.writeFile(
      path.join(root, 'sub', 'deep', 'c.bin'),
      Buffer.alloc(25),
    );
    await expect(dirUsage(root)).resolves.toEqual({
      bytes: 175,
      files: 3,
    });
  });

  it('reports zero for a missing directory', async () => {
    await expect(dirUsage(path.join(root, 'nope'))).resolves.toEqual({
      bytes: 0,
      files: 0,
    });
  });

  it('reports zero for an empty directory', async () => {
    await expect(dirUsage(root)).resolves.toEqual({ bytes: 0, files: 0 });
  });
});
