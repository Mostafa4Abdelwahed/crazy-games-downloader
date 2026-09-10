import { BadRequestException } from '@nestjs/common';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Like } from 'typeorm';
import { GameImportsService, normalizeSourceKey } from './game-imports.service';
import { SourceAccessRestrictedError } from './sources/source.interface';

function toEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    seq: 1,
    sourceUrl: 'https://www.crazygames.com/game/foo',
    sourceKey: normalizeSourceKey('https://www.crazygames.com/game/foo'),
    status: 'queued',
    progress: 0,
    detectedEngine: null,
    downloadedFiles: 0,
    totalFiles: 0,
    currentStep: 'queued',
    error: null,
    errorCode: null,
    diagnostics: null,
    packageUrl: null,
    logs: [
      { at: '2026-01-01T00:00:00.000Z', level: 'info', message: 'created' },
    ],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeService(repoOverrides: Record<string, jest.Mock> = {}) {
  let seqMax = 0; // shared MAX(seq) the createQueryBuilder mock reports
  const repo = {
    create: jest.fn((e) => e),
    save: jest.fn(async (e) => {
      if (e?.seq && e.seq > seqMax) seqMax = e.seq;
      return e;
    }),
    findOneOrFail: jest.fn(async ({ where }) => ({
      ...toEntity(),
      id: where.id,
    })),
    find: jest.fn(async () => [] as unknown[]),
    findOne: jest.fn(async () => null),
    findAndCount: jest.fn(async () => [[], 0] as unknown[]),
    remove: jest.fn(async (e) => e),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(async () => ({ max: String(seqMax) })),
    })),
    ...repoOverrides,
  };
  const policy = { assertAllowed: jest.fn() };
  const queue = { enqueue: jest.fn(async () => undefined) };
  const sources = { findAdapter: jest.fn() };
  const folders = {
    assertExists: jest.fn(async () => undefined),
    get: jest.fn(async (id: string) => ({
      id,
      name: 'My folder',
      createdAt: new Date().toISOString(),
      jobCounts: { total: 0, inFlight: 0, completed: 0, failed: 0 },
      packagesRoot: '/packages',
    })),
    list: jest.fn(async () => []),
    resolveByName: jest.fn(async (name: string) => ({
      id: `folder-${name}`,
      name,
      createdAt: new Date().toISOString(),
      jobCounts: { total: 0, inFlight: 0, completed: 0, failed: 0 },
      packagesRoot: '/packages',
    })),
  };
  const launchServer = jest.fn(async () => ({
    url: 'http://localhost:54321/',
    port: 54321,
    child: { kill: jest.fn(), pid: 4242 },
  }));
  const servers = {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    save: jest.fn(async (e) => e),
    delete: jest.fn(async () => ({ affected: 1 })),
    remove: jest.fn(async (e) => e),
    clear: jest.fn(async () => undefined),
  };
  const service = new GameImportsService(
    repo as never,
    policy as never,
    queue as never,
    sources as never,
    folders as never,
    jest.fn(() => null) as never,
    launchServer as never,
    servers as never,
  );
  return {
    service,
    repo,
    policy,
    queue,
    sources,
    folders,
    launchServer,
    servers,
  };
}

describe('GameImportsService dedup + batch', () => {
  describe('normalizeSourceKey', () => {
    it('treats trailing-slash, scheme, and fragment variants as the same game', () => {
      const a = normalizeSourceKey('https://www.crazygames.com/game/foo/');
      const b = normalizeSourceKey('HTTPS://WWW.CRAZYGAMES.COM/game/foo#top');
      const c = normalizeSourceKey('https://www.crazygames.com/game/foo');
      expect(a).toBe(c);
      expect(b).toBe(c);
    });

    it('keeps genuinely different games distinct', () => {
      expect(
        normalizeSourceKey('https://www.crazygames.com/game/foo'),
      ).not.toBe(normalizeSourceKey('https://www.crazygames.com/game/bar'));
    });
  });

  it('creates a fresh job the first time a URL is submitted', async () => {
    const { service, repo, queue } = makeService();
    const job = await service.create('https://www.crazygames.com/game/foo');
    expect(job.id).toBeTruthy();
    expect(repo.save).toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
  });

  it('reuses the in-flight job instead of creating a duplicate', async () => {
    const existing = toEntity({
      id: 'existing-run',
      status: 'downloading',
      currentStep: 'downloading',
    });
    const { service, repo, queue } = makeService({
      find: jest.fn(async () => [existing]),
      findOneOrFail: jest.fn(async ({ where }) => ({
        ...existing,
        id: where.id,
      })),
    });
    const job = await service.create('https://www.crazygames.com/game/foo');
    expect(job.id).toBe('existing-run');
    // Logged as reused and saved, but never re-enqueued.
    expect(
      existing.logs.some((l: { message: string }) =>
        /Duplicate submit/.test(l.message),
      ),
    ).toBe(true);
    expect(repo.save).toHaveBeenCalledWith(existing);
    expect(Object.values(queue.enqueue.mock.calls)).toHaveLength(0);
  });

  it('reuses a game that already exists, even after a failed run', async () => {
    const failed = toEntity({ id: 'old-run', status: 'failed' });
    const { service, queue } = makeService({
      find: jest.fn(async () => [failed]),
    });
    const res = await service.create('https://www.crazygames.com/game/foo');
    // Global dedup: the failed row is reused, never re-run.
    expect(res.id).toBe('old-run');
    expect(res.reused).toBe(true);
    expect(res.existingFolderName).toBeNull();
    expect(Object.values(queue.enqueue.mock.calls)).toHaveLength(0);
  });

  it('reports the folder name of an already-existing game', async () => {
    const existing = toEntity({
      id: 'old-run',
      status: 'completed',
      folderId: 'f-1',
    });
    const { service, queue } = makeService({
      find: jest.fn(async () => [existing]),
    });
    const res = await service.create('https://www.crazygames.com/game/foo');
    expect(res.reused).toBe(true);
    expect(res.existingFolderName).toBe('My folder');
    expect(Object.values(queue.enqueue.mock.calls)).toHaveLength(0);
  });

  it('rejects an unallowlisted URL before creating anything', async () => {
    const { service, repo, policy } = makeService();
    policy.assertAllowed.mockImplementation(() => {
      throw new Error('not allowlisted');
    });
    await expect(
      service.create('https://evil.example/game/foo'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('creates multiple distinct games in one batch', async () => {
    const { service, queue } = makeService();
    const res = await service.createBatch([
      'https://www.crazygames.com/game/foo',
      'https://www.crazygames.com/game/bar',
    ]);
    expect(res.reused).toBe(0);
    expect(res.created).toBe(2);
    expect(res.jobs).toHaveLength(2);
    expect(queue.enqueue.mock.calls).toHaveLength(2);
  });

  it('coalesces the same URL repeated inside a batch', async () => {
    const { service, queue } = makeService();
    const res = await service.createBatch([
      'https://www.crazygames.com/game/foo',
      'https://www.crazygames.com/game/foo/',
      '  https://www.crazygames.com/game/foo  ',
    ]);
    expect(res.jobs).toHaveLength(1);
    expect(queue.enqueue.mock.calls).toHaveLength(1);
  });

  it('batch reports duplicates with their folder names', async () => {
    const existing = toEntity({
      id: 'prior-run',
      status: 'completed',
      folderId: 'f-9',
    });
    const { service } = makeService({
      find: jest.fn(async ({ where }: never) =>
        (where as { sourceKey: string }).sourceKey ===
        normalizeSourceKey('https://www.crazygames.com/game/foo')
          ? [existing]
          : [],
      ),
    });
    const res = await service.createBatch([
      'https://www.crazygames.com/game/foo',
      'https://www.crazygames.com/game/new',
    ]);
    expect(res.created).toBe(1);
    expect(res.reused).toBe(1);
    expect(res.duplicates).toEqual([
      {
        sourceUrl: 'https://www.crazygames.com/game/foo',
        jobId: 'prior-run',
        folderName: 'My folder',
      },
    ]);
  });

  it('fails the whole batch fast when any URL is not allowlisted', async () => {
    const { service, policy } = makeService();
    policy.assertAllowed.mockImplementation(() => {
      // fail any URL in this batch so the whole request errors fast
      throw new Error('not allowlisted');
    });
    await expect(
      service.createBatch([
        'https://www.crazygames.com/game/foo',
        'https://evil.example/game/hack',
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires at least one URL for a batch', async () => {
    const { service } = makeService();
    await expect(service.createBatch(['  ', ''])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('backfills sourceKey for rows created before dedup existed', async () => {
    const legacy1 = toEntity({
      id: 'legacy-1',
      sourceUrl: 'https://www.crazygames.com/game/legacy-game',
      sourceKey: '',
    });
    const legacy2 = toEntity({
      id: 'legacy-2',
      sourceUrl: 'https://www.crazygames.com/game/legacy-game/',
      sourceKey: '',
    });
    const { service, repo } = makeService({
      find: jest.fn(async () => [legacy1, legacy2]),
    });
    await service.onModuleInit();
    expect(repo.save).toHaveBeenCalledWith([legacy1, legacy2]);
    expect(legacy1.sourceKey).toBe(
      'https://www.crazygames.com/game/legacy-game',
    );
    expect(legacy1.sourceKey).toBe(legacy2.sourceKey);
  });

  it('does nothing when every row already has a sourceKey', async () => {
    const { service, repo } = makeService();
    await service.onModuleInit();
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('GameImportsService discoverGames', () => {
  const adapter = {
    name: 'crazygames',
    listGames: jest.fn(async () => ({
      games: [
        { url: 'https://www.crazygames.com/game/foo', title: 'Foo' },
        { url: 'https://www.crazygames.com/game/bar', title: 'Bar' },
      ],
    })),
  };

  it('returns discovered games with the already flag based on existing sourceKeys', async () => {
    const completed = toEntity({
      id: 'bar-job',
      sourceUrl: 'https://www.crazygames.com/game/bar/',
      sourceKey: normalizeSourceKey('https://www.crazygames.com/game/bar/'),
      status: 'completed',
    });
    const { service, sources } = makeService({
      find: jest.fn(async ({ where }) => {
        if (
          Array.isArray(where?.sourceKey?._value) &&
          where.sourceKey._value.includes(completed.sourceKey)
        ) {
          return [completed];
        }
        return [] as unknown[];
      }),
    });
    sources.findAdapter.mockReturnValue(adapter);
    const res = await service.discoverGames(
      'https://www.crazygames.com/c/action',
    );
    expect(res.games).toEqual([
      {
        url: 'https://www.crazygames.com/game/foo',
        key: 'https://www.crazygames.com/game/foo',
        title: 'Foo',
        already: false,
      },
      {
        url: 'https://www.crazygames.com/game/bar',
        key: 'https://www.crazygames.com/game/bar',
        title: 'Bar',
        already: true,
        status: 'completed',
      },
    ]);
  });

  it('rejects a page URL that is not allowlisted before hitting the adapter', async () => {
    const { service, policy, sources } = makeService();
    policy.assertAllowed.mockImplementation(() => {
      throw new Error('not allowlisted');
    });
    await expect(
      service.discoverGames('https://evil.example/list'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sources.findAdapter).not.toHaveBeenCalled();
  });

  it('rejects pages no adapter can list', async () => {
    const { service, sources } = makeService();
    sources.findAdapter.mockReturnValue(null);
    await expect(
      service.discoverGames('https://www.crazygames.com/c/action'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns an empty list when the page has no game links', async () => {
    const empty = {
      name: 'crazygames',
      listGames: jest.fn(async () => ({
        games: [],
        note: 'Page "Empty" served 1 link(s), but none pointed at /game/{slug} pages.',
      })),
    };
    const { service, sources } = makeService();
    sources.findAdapter.mockReturnValue(empty);
    const res = await service.discoverGames(
      'https://www.crazygames.com/c/action',
    );
    expect(res.games).toEqual([]);
    expect(res.note).toContain('none pointed at /game/{slug}');
  });

  it('maps restricted/redirected source errors to 400 instead of 500', async () => {
    const restricted = {
      name: 'crazygames',
      listGames: jest.fn(async () => {
        throw new SourceAccessRestrictedError(
          'Source page indicates restricted access; will not attempt to bypass it.',
        );
      }),
    };
    const { service, sources } = makeService();
    sources.findAdapter.mockReturnValue(restricted);
    await expect(
      service.discoverGames('https://www.crazygames.com/c/action'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('GameImportsService list pagination', () => {
  it('returns one page with total and page metadata', async () => {
    const rows = [toEntity({ id: 'a' }), toEntity({ id: 'b' })];
    const { service, repo } = makeService({
      findAndCount: jest.fn(async () => [rows, 5] as unknown[]),
    });
    const res = await service.list(2, 2);
    expect(res.items).toHaveLength(2);
    expect(res.items[0].id).toBe('a');
    expect(res.total).toBe(5);
    expect(res.page).toBe(2);
    expect(res.pageSize).toBe(2);
    expect(res.totalPages).toBe(3);
    expect(repo.findAndCount).toHaveBeenCalledWith({
      order: { updatedAt: 'DESC' },
      skip: 2,
      take: 2,
    });
  });

  it('clamps limit and page to sane bounds', async () => {
    const { service, repo } = makeService();
    const res = await service.list(0, 9999);
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(200);
    expect(res.totalPages).toBe(1);
    expect(repo.findAndCount).toHaveBeenCalledWith({
      order: { updatedAt: 'DESC' },
      skip: 0,
      take: 200,
    });
  });

  it('defaults to page 1 with up to 50 rows', async () => {
    const { service, repo } = makeService();
    await service.list();
    expect(repo.findAndCount).toHaveBeenCalledWith({
      order: { updatedAt: 'DESC' },
      skip: 0,
      take: 50,
    });
  });

  it('returns lightweight table rows, not heavy job payloads', async () => {
    const full = toEntity({
      id: 'heavy',
      seq: 7,
      logs: [{ at: 'x', level: 'info', message: 'm' }],
      diagnostics: [{ level: 'error' as const, code: 'X', message: 'boom' }],
      packageUrl: '/srv/out/heavy',
      error: 'something failed',
      currentStep: 'downloading',
      detectedEngine: 'unity',
    });
    const { service } = makeService({
      findAndCount: jest.fn(async () => [[full], 1] as unknown[]),
    });
    const res = await service.list();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toEqual({
      id: 'heavy',
      seq: 7,
      sourceUrl: 'https://www.crazygames.com/game/foo',
      status: 'queued',
      progress: 0,
      updatedAt: expect.any(String),
      folderId: null,
    });
    // Heavy fields stay out of the listing entirely.
    expect(res.items[0]).not.toHaveProperty('logs');
    expect(res.items[0]).not.toHaveProperty('diagnostics');
    expect(res.items[0]).not.toHaveProperty('packageUrl');
    expect(res.items[0]).not.toHaveProperty('error');
  });

  it('filters by status and only accepts valid states', async () => {
    const { service, repo } = makeService();
    await service.list(1, 10, null, 'downloading');
    expect(repo.findAndCount).toHaveBeenCalledWith({
      where: { status: 'downloading' },
      order: { updatedAt: 'DESC' },
      skip: 0,
      take: 10,
    });
    // Invalid statuses are ignored rather than 500-ing.
    await service.list(1, 10, null, 'nonsense');
    expect(repo.findAndCount).toHaveBeenLastCalledWith({
      order: { updatedAt: 'DESC' },
      skip: 0,
      take: 10,
    });
  });

  it('sorts by seq/status/progress in both directions', async () => {
    const { service, repo } = makeService();
    await service.list(1, 10, null, null, 'seq', 'ASC');
    expect(repo.findAndCount).toHaveBeenCalledWith({
      order: { seq: 'ASC' },
      skip: 0,
      take: 10,
    });
    await service.list(1, 10, null, null, 'status', 'ASC');
    expect(repo.findAndCount).toHaveBeenLastCalledWith({
      order: { status: 'ASC' },
      skip: 0,
      take: 10,
    });
    await service.list(1, 10, null, null, 'progress', 'DESC');
    expect(repo.findAndCount).toHaveBeenLastCalledWith({
      order: { progress: 'DESC' },
      skip: 0,
      take: 10,
    });
    // Unknown sort keys fall back to updatedAt.
    await service.list(1, 10, null, null, 'bogus' as 'seq', 'DESC');
    expect(repo.findAndCount).toHaveBeenLastCalledWith({
      order: { updatedAt: 'DESC' },
      skip: 0,
      take: 10,
    });
  });

  it('assigns sequential job numbers at creation', async () => {
    const { service, repo } = makeService();
    await service.create('https://www.crazygames.com/game/one');
    await service.create('https://www.crazygames.com/game/two');
    // The second create's saved entity carries seq = 2 (unique, increasing).
    const savedSeqs = repo.save.mock.calls
      .map((c) => (c[0] as { seq?: number }).seq)
      .filter((s) => typeof s === 'number');
    expect(savedSeqs).toEqual([1, 2]);
  });

  it('searches jobs by URL substring combined with other filters', async () => {
    const { service, repo } = makeService();
    await service.list(1, 10, null, null, 'updatedAt', 'DESC', 'space');
    const calls = repo.findAndCount.mock.calls as unknown[][];
    const call = calls[0][0] as { where?: { sourceUrl?: unknown } };
    // Same LIKE substring the API would build; works next to folder/status.
    expect(call.where?.sourceUrl).toEqual(Like('%space%'));
    // Blank queries are ignored (no where clause at all).
    await service.list(1, 10);
    expect(repo.findAndCount).toHaveBeenLastCalledWith({
      order: { updatedAt: 'DESC' },
      skip: 0,
      take: 10,
    });
  });
});

describe('GameImportsService run/stop local server', () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cg2-import-'));
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('serves a completed job package via python http.server, like the manual command', async () => {
    const { service, launchServer } = makeService({
      findOne: jest.fn(async () =>
        toEntity({ status: 'completed', packageUrl: tmpDir }),
      ),
    });
    const res = await service.run('job-1');
    expect(res).toEqual({ url: 'http://localhost:54321/', port: 54321 });
    // Rooted at the package dir, exactly like `cd <dir>` + python -m http.server.
    expect(launchServer).toHaveBeenCalledWith(
      path.resolve(tmpDir),
      expect.any(Number),
    );
  });

  it('is idempotent: a second run reuses the running server', async () => {
    const { service, launchServer } = makeService({
      findOne: jest.fn(async () =>
        toEntity({ status: 'completed', packageUrl: tmpDir }),
      ),
    });
    await service.run('job-1');
    await service.run('job-1');
    expect(launchServer).toHaveBeenCalledTimes(1);
  });

  it('rejects non-completed jobs and missing package directories', async () => {
    const { service } = makeService({
      findOne: jest.fn(async () =>
        toEntity({ status: 'failed', packageUrl: null }),
      ),
    });
    await expect(service.run('job-1')).rejects.toThrow(
      'Only completed imports with a local package can be served.',
    );
  });

  it('rejects when the served package directory does not exist on this host', async () => {
    const { service } = makeService({
      findOne: jest.fn(async () =>
        toEntity({ status: 'completed', packageUrl: '/no/such/dir' }),
      ),
    });
    await expect(service.run('job-1')).rejects.toThrow(
      'Package directory not found on this host',
    );
  });

  it('stop kills the python server process and reports it stopped', async () => {
    const { service, launchServer } = makeService({
      findOne: jest.fn(async () =>
        toEntity({ status: 'completed', packageUrl: tmpDir }),
      ),
    });
    await service.run('job-1');
    const launched = await launchServer.mock.results[0].value;
    const res = await service.stop('job-1');
    expect(res).toEqual({ url: 'http://localhost:54321/', stopped: true });
    expect(launched.child.kill).toHaveBeenCalled();
  });

  it('stop is a no-op when no server is running for the job', async () => {
    const { service } = makeService();
    await expect(service.stop('missing')).resolves.toEqual({
      url: null,
      stopped: false,
    });
  });
});

describe('GameImportsService force re-import', () => {
  it('force bypasses the global dedup and starts a fresh run', async () => {
    const prior = toEntity({ id: 'old-run', status: 'failed' });
    const { service, queue } = makeService({
      find: jest.fn(async () => [prior]),
    });
    const job = await service.create(
      'https://www.crazygames.com/game/foo',
      null,
      true,
    );
    expect(job.id).not.toBe('old-run');
    expect(job.status).toBe('queued');
    expect(job.reused).toBe(false);
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
  });

  it('force applies to batches too', async () => {
    const prior = toEntity({ id: 'old-run', status: 'completed' });
    const { service } = makeService({
      find: jest.fn(async () => [prior]),
    });
    const res = await service.createBatch(
      ['https://www.crazygames.com/game/foo'],
      null,
      true,
    );
    expect(res.created).toBe(1);
    expect(res.reused).toBe(0);
    expect(res.duplicates).toEqual([]);
  });

  it('treats "none" as ungrouped instead of a folder id', async () => {
    const { service, folders } = makeService();
    await service.create('https://www.crazygames.com/game/foo', 'none');
    // No folder validation, no crash; the job is filed ungrouped.
    expect(folders.assertExists).not.toHaveBeenCalled();
    await service.createBatch(['https://www.crazygames.com/game/foo'], 'none');
    expect(folders.assertExists).not.toHaveBeenCalled();
  });
});

describe('GameImportsService remove (per-job delete)', () => {
  const OLD_ENV = { ...process.env };
  let workRoot: string;
  let storeRoot: string;

  async function exists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  beforeEach(async () => {
    workRoot = await mkdtemp(path.join(os.tmpdir(), 'rm-work-'));
    storeRoot = await mkdtemp(path.join(os.tmpdir(), 'rm-store-'));
    process.env.IMPORT_WORK_DIR = workRoot;
    process.env.STORAGE_LOCAL_ROOT = storeRoot;
  });

  afterEach(async () => {
    process.env = { ...OLD_ENV };
    await rm(workRoot, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('removes the row, its package dir and its work dir', async () => {
    const pkgDir = path.join(storeRoot, 'job-1');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(path.join(pkgDir, 'index.html'), 'x');
    await mkdir(path.join(workRoot, 'job-1'), { recursive: true });
    const entity = toEntity({
      id: 'job-1',
      status: 'completed',
      packageUrl: pkgDir,
    });
    const { service, repo } = makeService({
      findOne: jest.fn(async () => entity),
    });
    const res = await service.remove('job-1');
    expect(res).toEqual({
      deleted: true,
      clearedPackage: true,
      clearedWork: true,
      wasRunning: false,
    });
    expect(repo.remove).toHaveBeenCalledWith(entity);
    expect(await exists(pkgDir)).toBe(false);
    expect(await exists(path.join(workRoot, 'job-1'))).toBe(false);
  });

  it('never deletes package paths outside the storage root', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'rm-outside-'));
    await writeFile(path.join(outside, 'keep.txt'), 'x');
    const entity = toEntity({
      id: 'job-9',
      status: 'failed',
      packageUrl: outside,
    });
    try {
      const { service } = makeService({
        findOne: jest.fn(async () => entity),
      });
      const res = await service.remove('job-9');
      expect(res.clearedPackage).toBe(false);
      // The foreign directory is untouched.
      expect(await exists(path.join(outside, 'keep.txt'))).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('stops a running server before deleting its job', async () => {
    const pkgDir = path.join(storeRoot, 'job-run');
    await mkdir(pkgDir, { recursive: true });
    const entity = toEntity({
      id: 'job-run',
      status: 'completed',
      packageUrl: pkgDir,
    });
    const { service, launchServer } = makeService({
      findOne: jest.fn(async () => entity),
    });
    await service.run('job-run');
    const launched = await launchServer.mock.results[0].value;
    const res = await service.remove('job-run');
    expect(res.wasRunning).toBe(true);
    expect(launched.child.kill).toHaveBeenCalled();
  });

  it('cancels an in-flight job first so the worker bails out', async () => {
    const entity = toEntity({ id: 'job-2', status: 'downloading' });
    const { service, repo } = makeService({
      findOne: jest.fn(async () => entity),
    });
    await service.remove('job-2');
    const saved = repo.save.mock.calls.at(-1)?.[0] as { status?: string };
    expect(saved.status).toBe('cancelled');
    expect(repo.remove).toHaveBeenCalledWith(entity);
  });

  it('404s for an unknown job id', async () => {
    const { service } = makeService();
    await expect(service.remove('nope')).rejects.toThrow(
      'Import job not found',
    );
  });
});

describe('GameImportsService retryFailed', () => {
  function failedRows() {
    return [
      toEntity({
        id: 'f-a',
        status: 'failed',
        sourceUrl: 'https://www.crazygames.com/game/aa',
        folderId: 'f-1',
      }),
      toEntity({
        id: 'f-b',
        status: 'failed',
        sourceUrl: 'https://www.crazygames.com/game/bb',
        folderId: 'f-1',
      }),
    ];
  }

  it('re-queues failed rows in place without adding rows', async () => {
    const rows = failedRows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const { service, queue, repo } = makeService({
      find: jest.fn(async () => rows),
      findOne: jest.fn(async ({ where }: never) => {
        const w = where as { id: string };
        return byId.get(w.id) ?? null;
      }),
    });
    const res = await service.retryFailed('f-1');
    expect(res.retried).toBe(2);
    expect(res.jobs.map((j) => j.id).sort()).toEqual(['f-a', 'f-b']);
    expect(res.jobs.every((j) => j.status === 'queued')).toBe(true);
    const enqueued = (queue.enqueue.mock.calls as unknown[][]).map((c) => c[0]);
    expect(enqueued.sort()).toEqual(['f-a', 'f-b']);
    // Same rows reset — never new ones (folder totals stay stable).
    expect(repo.create).not.toHaveBeenCalled();
    expect(rows[0].error).toBeNull();
    expect(rows[0].progress).toBe(0);
  });

  it('returns zero when nothing failed', async () => {
    const { service } = makeService();
    await expect(service.retryFailed('f-1')).resolves.toEqual({
      retried: 0,
      jobs: [],
    });
  });
});

describe('GameImportsService retryJobs', () => {
  it('retries failed and cancelled rows, skipping the rest', async () => {
    const byId: Record<string, ReturnType<typeof toEntity>> = {
      'f-a': toEntity({ id: 'f-a', status: 'failed' }),
      'c-a': toEntity({ id: 'c-a', status: 'cancelled' }),
      'run-a': toEntity({ id: 'run-a', status: 'downloading' }),
      'done-a': toEntity({ id: 'done-a', status: 'completed' }),
    };
    const { service, queue } = makeService({
      findOne: jest.fn(async ({ where }: never) => {
        const w = where as { id: string };
        return byId[w.id] ?? null;
      }),
    });
    const res = await service.retryJobs([
      'f-a',
      'c-a',
      'run-a',
      'done-a',
      'missing',
      'f-a',
    ]);
    expect(res.retried).toBe(2);
    expect(res.jobs.map((j) => j.id).sort()).toEqual(['c-a', 'f-a']);
    const enqueued = (queue.enqueue.mock.calls as unknown[][]).map((c) => c[0]);
    expect(enqueued.sort()).toEqual(['c-a', 'f-a']);
    expect(res.skipped).toEqual([
      { id: 'run-a', reason: 'status-downloading' },
      { id: 'done-a', reason: 'status-completed' },
      { id: 'missing', reason: 'not-found' },
    ]);
  });
});

describe('GameImportsService run-server persistence', () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cg2-run-'));
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function completedService(entityOverrides: Record<string, unknown> = {}) {
    return makeService({
      findOne: jest.fn(async () =>
        toEntity({
          status: 'completed',
          packageUrl: tmpDir,
          ...entityOverrides,
        }),
      ),
    });
  }

  it('persists a run row on Start and drops it on Stop', async () => {
    const { service, servers } = completedService();
    await service.run('job-1');
    expect(servers.save).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        port: 54321,
        pid: 4242,
        url: 'http://localhost:54321/',
      }),
    );
    await service.stop('job-1');
    expect(servers.delete).toHaveBeenCalledWith({ jobId: 'job-1' });
  });

  it('stop falls back to the persisted row when the live handle is gone', async () => {
    const killSpy = jest
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as never);
    try {
      const row = {
        jobId: 'job-9',
        port: 54321,
        pid: 9999,
        url: 'http://localhost:54321/',
        root: tmpDir,
      };
      const { service, servers } = makeService({
        findOne: jest.fn(async () => null),
      });
      (servers.findOne as jest.Mock).mockResolvedValueOnce(row);
      const res = await service.stop('job-9');
      expect(res).toEqual({ url: 'http://localhost:54321/', stopped: true });
      expect(killSpy).toHaveBeenCalledWith(9999, 'SIGTERM');
      expect(servers.delete).toHaveBeenCalledWith({ jobId: 'job-9' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('remove() also drops the persisted run row', async () => {
    const entity = toEntity({
      id: 'job-1',
      status: 'completed',
      packageUrl: tmpDir,
    });
    const { service, servers } = makeService({
      findOne: jest.fn(async () => entity),
    });
    (servers.findOne as jest.Mock).mockResolvedValueOnce({
      jobId: 'job-1',
      port: 54321,
      pid: null,
      url: 'http://localhost:54321/',
      root: tmpDir,
    });
    const res = await service.remove('job-1');
    expect(res.wasRunning).toBe(true);
    expect(servers.delete).toHaveBeenCalledWith({ jobId: 'job-1' });
  });

  it('reconcile kills orphans whose port still answers, forgets the rest', async () => {
    const net = await import('node:net');
    // A real listener = the "port still answers" case.
    const srv: import('node:net').Server = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const openPort = (srv.address() as import('node:net').AddressInfo).port;
    // A just-closed listener = a guaranteed-closed port.
    const closed: import('node:net').Server = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const closedPort = (closed.address() as import('node:net').AddressInfo)
      .port;
    await new Promise<void>((r) => closed.close(() => r()));
    const rows = [
      { jobId: 'a', port: openPort, pid: 1111, url: 'u1', root: '/x' },
      { jobId: 'b', port: closedPort, pid: 2222, url: 'u2', root: '/y' },
      { jobId: 'c', port: closedPort, pid: 3333, url: 'u3', root: '/z' },
    ];
    // pid 3333 is dead; the others look alive.
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      if (signal === 0 && pid === 3333) {
        const e = new Error('ESRCH') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      }
      return true;
    }) as never);
    try {
      const removed: unknown[] = [];
      const { service, servers } = makeService();
      (servers.find as jest.Mock).mockResolvedValueOnce(rows);
      (servers.remove as jest.Mock).mockImplementation(async (e: unknown) => {
        removed.push(e);
        return e;
      });
      const res = await service.reconcileRunServers();
      expect(res).toEqual({ killed: 1, cleared: 3 });
      expect(removed).toHaveLength(3);
      // Only the orphan whose port still answers gets a real kill signal.
      const kills = killSpy.mock.calls.filter((c) => c[1] === 'SIGTERM');
      expect(kills).toEqual([[1111, 'SIGTERM']]);
    } finally {
      killSpy.mockRestore();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('reconcile is a no-op when there are no stale rows', async () => {
    const { service, servers } = makeService();
    await expect(service.reconcileRunServers()).resolves.toEqual({
      killed: 0,
      cleared: 0,
    });
    expect(servers.remove).not.toHaveBeenCalled();
  });
});

describe('GameImportsService importBackup', () => {
  it('creates missing folders, reuses names, skips existing games', async () => {
    const { service, folders } = makeService({
      find: jest.fn(async () => []),
    });
    const res = await service.importBackup({
      folders: [
        {
          name: 'Action',
          games: [{ sourceUrl: 'https://www.crazygames.com/game/aa' }],
        },
        {
          name: 'Action',
          games: [{ sourceUrl: 'https://www.crazygames.com/game/bb' }],
        },
        {
          name: 'Ungrouped',
          games: [{ sourceUrl: 'https://www.crazygames.com/game/cc' }],
        },
      ],
    });
    expect(res).toEqual({
      foldersCreated: 1,
      foldersReused: 0,
      gamesCreated: 3,
      gamesSkipped: 0,
    });
    // Same name resolved once; ungrouped never touches folders.
    expect(folders.resolveByName).toHaveBeenCalledTimes(1);
    expect(folders.resolveByName).toHaveBeenCalledWith('Action');
  });

  it('reuses pre-existing folders and skips already-imported games', async () => {
    const prior = toEntity({
      id: 'old-run',
      status: 'completed',
      sourceUrl: 'https://www.crazygames.com/game/aa',
    });
    const { service, folders } = makeService({
      find: jest.fn(async ({ where }: any) =>
        String(where?.sourceKey ?? '').includes('/aa') ? [prior] : [],
      ),
    });
    (folders.list as jest.Mock).mockResolvedValueOnce([
      { id: 'f-action', name: 'Action' },
    ]);
    (folders.resolveByName as jest.Mock).mockResolvedValueOnce({
      id: 'f-action',
      name: 'Action',
    });
    const res = await service.importBackup({
      folders: [
        {
          name: 'Action',
          games: [
            { sourceUrl: 'https://www.crazygames.com/game/aa' },
            { sourceUrl: 'https://www.crazygames.com/game/bb' },
          ],
        },
      ],
    });
    expect(res).toEqual({
      foldersCreated: 0,
      foldersReused: 1,
      gamesCreated: 1,
      gamesSkipped: 1,
    });
  });

  it('ignores malformed groups and empty urls', async () => {
    const { service } = makeService({
      find: jest.fn(async () => []),
    });
    const res = await service.importBackup({
      folders: [
        { name: '  ', games: [{ sourceUrl: 'https://x.example/1' }] },
        { name: 'Ok', games: [{ sourceUrl: '' }, {}] },
      ] as never,
    });
    expect(res.gamesCreated).toBe(0);
    expect(res.gamesSkipped).toBe(0);
  });
});

describe('GameImportsService get package size', () => {
  let pkgDir: string;
  beforeAll(async () => {
    pkgDir = await mkdtemp(path.join(os.tmpdir(), 'cg2-size-'));
    await mkdir(path.join(pkgDir, 'Build'), { recursive: true });
    await writeFile(path.join(pkgDir, 'index.html'), Buffer.alloc(100));
    await writeFile(path.join(pkgDir, 'Build', 'game.wasm'), Buffer.alloc(200));
  });
  afterAll(async () => {
    await rm(pkgDir, { recursive: true, force: true });
  });

  it('reports on-disk bytes and file count for a stored package', async () => {
    const { service } = makeService({
      findOne: jest.fn(async () =>
        toEntity({ status: 'completed', packageUrl: pkgDir }),
      ),
    });
    const job = await service.get('job-1');
    expect(job.packageBytes).toBe(300);
    expect(job.packageFiles).toBe(2);
  });

  it('reports null size when there is no package', async () => {
    const { service } = makeService({
      findOne: jest.fn(async () =>
        toEntity({ status: 'failed', packageUrl: null }),
      ),
    });
    const job = await service.get('job-1');
    expect(job.packageBytes).toBeNull();
    expect(job.packageFiles).toBeNull();
  });

  it('reports zero for a package directory that went missing', async () => {
    const { service } = makeService({
      findOne: jest.fn(async () =>
        toEntity({
          status: 'completed',
          packageUrl: path.join(pkgDir, 'gone'),
        }),
      ),
    });
    const job = await service.get('job-1');
    expect(job.packageBytes).toBe(0);
    expect(job.packageFiles).toBe(0);
  });
});

describe('GameImportsService stopAllRuns', () => {
  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cg2-stopall-'));
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('stops every live server and drops their rows', async () => {
    const { service, launchServer, servers } = makeService({
      findOne: jest.fn(async () =>
        toEntity({ status: 'completed', packageUrl: tmpDir }),
      ),
    });
    await service.run('job-1');
    await service.run('job-2');
    const kids: { kill: jest.Mock }[] = [];
    for (const r of launchServer.mock.results) {
      kids.push(((await r.value) as { child: { kill: jest.Mock } }).child);
    }
    const res = await service.stopAllRuns();
    expect(res).toEqual({ stopped: 2 });
    expect(kids[0].kill).toHaveBeenCalled();
    expect(kids[1].kill).toHaveBeenCalled();
    expect(servers.delete).toHaveBeenCalledWith({ jobId: 'job-1' });
    expect(servers.delete).toHaveBeenCalledWith({ jobId: 'job-2' });
  });

  it('sweeps persisted rows that have no live handle, killing by pid', async () => {
    const killSpy = jest
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as never);
    try {
      const rows = [{ jobId: 'x', port: 1, pid: 4242, url: 'u', root: '/x' }];
      const { service, servers } = makeService();
      (servers.find as jest.Mock).mockResolvedValueOnce(rows);
      const res = await service.stopAllRuns();
      expect(res).toEqual({ stopped: 0 });
      // First call is SIGTERM (killPid); later calls are signal-0 probes
      // from waitForReleases — both are fine as long as SIGTERM fires.
      expect(killSpy.mock.calls[0]).toEqual([4242, 'SIGTERM']);
      expect(servers.clear).toHaveBeenCalledTimes(1);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('is a no-op when nothing runs', async () => {
    const { service, servers } = makeService();
    await expect(service.stopAllRuns()).resolves.toEqual({ stopped: 0 });
    expect(servers.clear).not.toHaveBeenCalled();
  });
});
