import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SettingsService } from './settings.service';

const OLD_ENV = { ...process.env };

function makeRepo(rows: any[] = []) {
  return {
    find: jest.fn(async () => rows.map((r) => ({ id: r }))),
    remove: jest.fn(async (entities: any[]) => {
      rows.length = 0;
      return entities;
    }),
    count: jest.fn(async () => rows.length),
  };
}

describe('SettingsService', () => {
  let tmpRoot: string;
  let workDir: string;
  let storeDir: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
    workDir = path.join(tmpRoot, 'work');
    storeDir = path.join(tmpRoot, 'packages');
    fs.mkdirSync(path.join(workDir, 'job-1'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'job-2'), { recursive: true });
    fs.mkdirSync(path.join(storeDir, 'pkg-1'), { recursive: true });
    process.env.IMPORT_WORK_DIR = workDir;
    process.env.STORAGE_LOCAL_ROOT = storeDir;
    process.env.STORAGE_DRIVER = 'local';
    process.env.QUEUE_DRIVER = 'memory';
    delete process.env.REDIS_URL;
    process.env.SOURCE_ALLOWED_HOSTS =
      'www.crazygames.com,files.crazygames.com';
    process.env.ALLOW_ANY_HTTPS = 'false';
  });

  afterAll(() => {
    process.env = { ...OLD_ENV };
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    // Recreate dirs cleared by destructive tests so each test starts clean.
    fs.mkdirSync(path.join(workDir, 'job-1'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'job-2'), { recursive: true });
    fs.mkdirSync(path.join(storeDir, 'pkg-1'), { recursive: true });
  });

  describe('view()', () => {
    it('returns grouped settings with resolved paths and stats', async () => {
      const svc = new SettingsService(makeRepo(['a', 'b']) as never);
      const v = await svc.view();
      expect(v.queue.driver).toBe('memory');
      expect(v.queue.redisUrl).toBe(false);
      expect(v.database.driver).toBe('sqlite');
      expect(v.paths.workDir).toBe(path.resolve(workDir));
      expect(v.paths.storageRoot).toBe(path.resolve(storeDir));
      expect(v.security.allowedHosts).toEqual([
        'www.crazygames.com',
        'files.crazygames.com',
      ]);
      expect(v.security.allowAnyHttps).toBe(false);
      expect(v.security.blockPrivateNetworks).toBe(true);
      expect(v.security.cloudMetadataBlock).toBe(true);
      expect(v.runtime.streamingAssetsRuntimeDiscovery).toBe(true);
      expect(v.runtime.streamingAssetsLocalDiscovery).toBe(true);
      expect(v.stats).toEqual({ jobs: 2, packages: 1, workDirs: 2 });
    });

    it('reflects bullmq + postgres when configured', async () => {
      process.env.DATABASE_URL = 'postgres://x';
      process.env.REDIS_URL = 'redis://x';
      process.env.QUEUE_DRIVER = 'bullmq';
      try {
        const svc = new SettingsService(makeRepo() as never);
        const v = await svc.view();
        expect(v.database.driver).toBe('postgres');
        expect(v.queue.driver).toBe('bullmq');
        expect(v.queue.redisUrl).toBe(true);
      } finally {
        delete process.env.DATABASE_URL;
        delete process.env.REDIS_URL;
        process.env.QUEUE_DRIVER = 'memory';
      }
    });

    it('never leaks the redis URL value itself', async () => {
      const svc = new SettingsService(makeRepo() as never);
      const raw = JSON.stringify(await svc.view());
      expect(raw).not.toContain('redis://');
    });
  });

  describe('destructive actions require confirmation', () => {
    it('rejects clear/clear-jobs without the phrase', async () => {
      const svc = new SettingsService(makeRepo() as never);
      await expect(svc.clearJobs('')).rejects.toThrow('Type DELETE');
      await expect(svc.clearJobs('delete now')).rejects.toThrow('Type DELETE');
      await expect(svc.clearWork('yes')).rejects.toThrow('Type DELETE');
      await expect(svc.clearPackages('please')).rejects.toThrow('Type DELETE');
      await expect(svc.resetAll('ok')).rejects.toThrow('Type DELETE');
    });

    it('accepts the phrase case-insensitively', async () => {
      const svc = new SettingsService(makeRepo(['x']) as never);
      await expect(svc.clearJobs(' delete ')).resolves.toEqual({
        cleared: 1,
      });
    });
  });

  describe('clear actions', () => {
    it('clearJobs removes every job row and reports the count', async () => {
      const repo = makeRepo(['a', 'b', 'c']);
      const svc = new SettingsService(repo as never);
      await expect(svc.clearJobs('DELETE')).resolves.toEqual({
        cleared: 3,
      });
      expect(repo.remove).toHaveBeenCalledTimes(1);
    });

    it('clearWork removes every child of the work dir', async () => {
      const svc = new SettingsService(makeRepo() as never);
      await expect(svc.clearWork('DELETE')).resolves.toEqual({ cleared: 2 });
      expect(fs.readdirSync(workDir)).toEqual([]);
    });

    it('clearPackages removes every stored package', async () => {
      const svc = new SettingsService(makeRepo() as never);
      await expect(svc.clearPackages('DELETE')).resolves.toEqual({
        cleared: 1,
      });
      expect(fs.readdirSync(storeDir)).toEqual([]);
    });

    it('clearWork/clearPackages are no-ops when the root is missing', async () => {
      process.env.IMPORT_WORK_DIR = path.join(tmpRoot, 'nope');
      process.env.STORAGE_LOCAL_ROOT = path.join(tmpRoot, 'nope2');
      try {
        const svc = new SettingsService(makeRepo() as never);
        await expect(svc.clearWork('DELETE')).resolves.toEqual({ cleared: 0 });
        await expect(svc.clearPackages('DELETE')).resolves.toEqual({
          cleared: 0,
        });
      } finally {
        process.env.IMPORT_WORK_DIR = workDir;
        process.env.STORAGE_LOCAL_ROOT = storeDir;
      }
    });

    it('resetAll wipes jobs + work dirs + packages in one go', async () => {
      const svc = new SettingsService(makeRepo(['a', 'b']) as never);
      await expect(svc.resetAll('DELETE')).resolves.toEqual({
        clearedJobs: 2,
        clearedWork: 2,
        clearedPackages: 1,
      });
      expect(fs.readdirSync(workDir)).toEqual([]);
      expect(fs.readdirSync(storeDir)).toEqual([]);
    });
  });
});
