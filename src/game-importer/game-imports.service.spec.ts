import { BadRequestException } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GameImportsService, normalizeSourceKey } from './game-imports.service';
import { SourceAccessRestrictedError } from './sources/source.interface';

function toEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
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
  const repo = {
    create: jest.fn((e) => e),
    save: jest.fn(async (e) => e),
    findOneOrFail: jest.fn(async ({ where }) => {
      return { ...toEntity(), id: where.id };
    }),
    find: jest.fn(async () => [] as unknown[]),
    findAndCount: jest.fn(async () => [[], 0] as unknown[]),
    ...repoOverrides,
  };
  const policy = { assertAllowed: jest.fn() };
  const queue = { enqueue: jest.fn(async () => undefined) };
  const sources = { findAdapter: jest.fn() };
  const launchServer = jest.fn(async () => ({
    url: 'http://localhost:54321/',
    port: 54321,
    child: { kill: jest.fn() },
  }));
  const service = new GameImportsService(
    repo as never,
    policy as never,
    queue as never,
    sources as never,
    jest.fn(() => null) as never,
    launchServer as never,
  );
  return { service, repo, policy, queue, sources, launchServer };
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

  it('starts a fresh run (update) after a terminal status', async () => {
    const failed = toEntity({ id: 'old-run', status: 'failed' });
    const { service, queue } = makeService({
      find: jest.fn(async () => [failed]),
    });
    const job = await service.create('https://www.crazygames.com/game/foo');
    expect(job.id).not.toBe('old-run');
    expect(job.status).toBe('queued');
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
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
      sourceUrl: 'https://www.crazygames.com/game/foo',
      status: 'queued',
      progress: 0,
      updatedAt: expect.any(String),
    });
    // Heavy fields stay out of the listing entirely.
    expect(res.items[0]).not.toHaveProperty('logs');
    expect(res.items[0]).not.toHaveProperty('diagnostics');
    expect(res.items[0]).not.toHaveProperty('packageUrl');
    expect(res.items[0]).not.toHaveProperty('error');
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
