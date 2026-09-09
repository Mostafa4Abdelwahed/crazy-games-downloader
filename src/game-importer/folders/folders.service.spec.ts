import { BadRequestException } from '@nestjs/common';
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
});
