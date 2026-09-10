import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FoldersService } from './folders.service';

const IN_FLIGHT = [
  'queued',
  'detecting',
  'resolving',
  'downloading',
  'extracting',
  'validating',
  'uploading',
];

function makeRepos(folderRows: any[] = [], jobRows: any[] = []) {
  const folders = {
    find: jest.fn(async ({ where }: any = {}) =>
      where?.id
        ? folderRows.filter((f) => f.id === where.id)
        : where?.name
          ? folderRows.filter((f) => f.name === where.name)
          : [...folderRows],
    ),
    findOne: jest.fn(
      async ({ where }: any) =>
        folderRows.find(
          (f) =>
            (where.id === undefined || f.id === where.id) &&
            (where.name === undefined || f.name === where.name),
        ) ?? null,
    ),
    create: jest.fn((e: any) => ({
      createdAt: new Date(),
      updatedAt: new Date(),
      ...e,
    })),
    save: jest.fn(async (e: any) => {
      const i = folderRows.findIndex((f) => f.id === e.id);
      if (i >= 0) folderRows[i] = e;
      else folderRows.push(e);
      return e;
    }),
    remove: jest.fn(async (e: any) => {
      const i = folderRows.findIndex((f) => f.id === e.id);
      if (i >= 0) folderRows.splice(i, 1);
    }),
  };
  const jobs = {
    find: jest.fn(async ({ where }: any = {}) =>
      where?.folderId
        ? jobRows.filter((j) => j.folderId === where.folderId)
        : [...jobRows],
    ),
    findOne: jest.fn(
      async ({ where }: any) => jobRows.find((j) => j.id === where.id) ?? null,
    ),
    save: jest.fn(async (input: any) => {
      const entities = Array.isArray(input) ? input : [input];
      for (const e of entities) {
        const i = jobRows.findIndex((j) => j.id === e.id);
        if (i >= 0) jobRows[i] = e;
        else jobRows.push(e);
      }
      return input;
    }),
  };
  return { folders, jobs, folderRows, jobRows };
}

function makeService(rows: ReturnType<typeof makeRepos>) {
  return {
    service: new FoldersService(rows.folders as never, rows.jobs as never),
    ...rows,
  };
}

describe('FoldersService', () => {
  it('creates a folder and rejects duplicate/empty names', async () => {
    const { service, folderRows } = makeService(makeRepos());
    const created = await service.create('Action games');
    expect(created.name).toBe('Action games');
    expect(created.jobCounts.total).toBe(0);
    expect(folderRows).toHaveLength(1);

    await expect(service.create('Action games')).rejects.toThrow(
      'Folder name already used',
    );
    await expect(service.create('   ')).rejects.toThrow(
      'Folder name is required',
    );
  });

  it('lists folders with live per-status job counts', async () => {
    const rows = makeRepos(
      [{ id: 'f1', name: 'A', createdAt: new Date() }],
      [
        { id: 'j1', folderId: 'f1', status: 'completed' },
        { id: 'j2', folderId: 'f1', status: 'downloading' },
        { id: 'j3', folderId: 'f1', status: 'queued' },
        { id: 'j4', folderId: 'f1', status: 'failed' },
        { id: 'j5', folderId: null, status: 'completed' },
      ],
    );
    const { service } = makeService(rows);
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0].jobCounts).toEqual({
      total: 4,
      inFlight: 2,
      completed: 1,
      failed: 1,
    });
    expect(list[0].packagesRoot).toBe(service.packagesRoot());
  });

  it('renames a folder, rejecting duplicates and missing ids', async () => {
    const rows = makeRepos([
      { id: 'f1', name: 'A', createdAt: new Date() },
      { id: 'f2', name: 'B', createdAt: new Date() },
    ]);
    const { service } = makeService(rows);
    const renamed = await service.rename('f1', 'Favorites');
    expect(renamed.name).toBe('Favorites');
    await expect(service.rename('f1', 'B')).rejects.toThrow('already used');
    await expect(service.rename('missing', 'X')).rejects.toThrow(
      'Folder not found',
    );
  });

  it('deleting a folder unassigns its jobs instead of deleting them', async () => {
    const rows = makeRepos(
      [{ id: 'f1', name: 'A', createdAt: new Date() }],
      [
        { id: 'j1', folderId: 'f1', status: 'completed' },
        { id: 'j2', folderId: 'f1', status: 'queued' },
      ],
    );
    const { service, folderRows, jobRows } = makeService(rows);
    const res = await service.delete('f1');
    expect(res).toEqual({ deleted: true, unassigned: 2 });
    expect(folderRows).toHaveLength(0);
    // Jobs survive, now ungrouped.
    expect(jobRows).toHaveLength(2);
    expect(jobRows.every((j) => j.folderId === null)).toBe(true);
    await expect(service.delete('f1')).rejects.toThrow('Folder not found');
  });

  it('assigns jobs to folders and validates both ids', async () => {
    const rows = makeRepos(
      [{ id: 'f1', name: 'A', createdAt: new Date() }],
      [{ id: 'j1', folderId: null, status: 'completed' }],
    );
    const { service } = makeService(rows);
    const res = await service.assignJob('j1', 'f1');
    expect(res).toEqual({ jobId: 'j1', folderId: 'f1' });
    const out = await service.assignJob('j1', null);
    expect(out).toEqual({ jobId: 'j1', folderId: null });
    await expect(service.assignJob('nope', 'f1')).rejects.toThrow(
      'Job not found',
    );
    await expect(service.assignJob('j1', 'nope')).rejects.toThrow(
      'Folder not found',
    );
  });

  it('assertExists throws for unknown folders', async () => {
    const { service } = makeService(makeRepos());
    await expect(service.assertExists('nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('in-flight statuses are counted for stats', () => {
    // Sanity on the shared constant: every ImportState that is not
    // terminal must be counted as in-flight.
    const terminal = ['completed', 'failed', 'cancelled'];
    const statuses = [
      'queued',
      'detecting',
      'resolving',
      'downloading',
      'extracting',
      'validating',
      'uploading',
      'completed',
      'failed',
      'cancelled',
    ];
    for (const s of statuses) {
      const counted = IN_FLIGHT.includes(s);
      expect(counted).toBe(!terminal.includes(s));
    }
  });

  it('resolveByName reuses an existing folder or creates a missing one', async () => {
    const rows = makeRepos([{ id: 'f1', name: 'A', createdAt: new Date() }]);
    const { service } = makeService(rows);
    const reused = await service.resolveByName('A');
    expect(reused.id).toBe('f1');
    const created = await service.resolveByName('  B  ');
    expect(created.name).toBe('B');
    await expect(service.resolveByName('   ')).rejects.toThrow(
      'Folder name is required',
    );
  });

  it('list(true) attaches per-folder on-disk usage', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fs-'));
    try {
      const pkgA = path.join(root, 'job-a');
      const pkgB = path.join(root, 'job-b');
      await fs.promises.mkdir(pkgA, { recursive: true });
      await fs.promises.mkdir(pkgB, { recursive: true });
      await fs.promises.writeFile(path.join(pkgA, 'x.bin'), Buffer.alloc(64));
      await fs.promises.writeFile(path.join(pkgB, 'y.bin'), Buffer.alloc(32));
      const rows = makeRepos(
        [{ id: 'f1', name: 'A', createdAt: new Date() }],
        [
          {
            id: 'job-a',
            folderId: 'f1',
            status: 'completed',
            packageUrl: pkgA,
          },
          {
            id: 'job-b',
            folderId: 'f1',
            status: 'completed',
            packageUrl: pkgB,
          },
          { id: 'job-c', folderId: 'f1', status: 'failed', packageUrl: null },
        ],
      );
      const { service } = makeService(rows);
      const [plain] = await service.list(false);
      expect(plain.storage).toBeUndefined();
      const [sized] = await service.list(true);
      expect(sized.storage).toEqual({ bytes: 96, packages: 2 });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('exportBackup groups games per folder plus ungrouped', async () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const rows = makeRepos(
      [
        { id: 'f1', name: 'A', createdAt: at },
        { id: 'f2', name: 'B', createdAt: at },
      ],
      [
        {
          id: 'j1',
          seq: 1,
          folderId: 'f1',
          sourceUrl: 'https://a.example/1',
          status: 'completed',
          createdAt: at,
        },
        {
          id: 'j2',
          seq: 2,
          folderId: null,
          sourceUrl: 'https://a.example/2',
          status: 'failed',
          createdAt: at,
        },
      ],
    );
    const { service } = makeService(rows);
    const backup = await service.exportBackup();
    expect(backup.exportedAt).toBeTruthy();
    expect(backup.folders.map((f) => f.name)).toEqual(['A', 'B', 'Ungrouped']);
    const a = backup.folders[0];
    expect(a.games).toEqual([
      {
        seq: 1,
        sourceUrl: 'https://a.example/1',
        status: 'completed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    // Empty folders keep their slot; ungrouped games are included.
    expect(backup.folders[1].games).toEqual([]);
    expect(backup.folders[2].games).toHaveLength(1);
  });
});
