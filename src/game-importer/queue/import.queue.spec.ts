import { ImportQueueService } from './import.queue';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('ImportQueueService memory driver', () => {
  let queue: ImportQueueService;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.QUEUE_DRIVER;
    queue = new ImportQueueService();
    expect(queue.getDriver()).toBe('memory');
  });

  it('processes enqueued jobs strictly one at a time, in FIFO order', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let active = 0;
    let maxActive = 0;
    queue.setProcessor(async (jobId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(jobId);
      await tick(10);
      active -= 1;
      finished.push(jobId);
    });

    await queue.enqueue('a');
    await queue.enqueue('b');
    await queue.enqueue('c');

    // Wait for the whole backlog to drain.
    for (
      let i = 0;
      i < 60 && (finished.length < 3 || queue.pendingCount() > 0);
      i += 1
    )
      await tick(5);

    expect(finished).toEqual(['a', 'b', 'c']);
    expect(started).toEqual(['a', 'b', 'c']);
    // Never ran two downloads at the same time (max concurrency == 1).
    expect(maxActive).toBe(1);
    // Nothing left queued.
    expect(queue.pendingCount()).toBe(0);
  });

  it('keeps serial ordering even when a job throws', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let active = 0;
    let maxActive = 0;
    queue.setProcessor(async (jobId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(jobId);
      await tick(5);
      active -= 1;
      finished.push(jobId);
      if (jobId === 'a') throw new Error('boom');
    });

    await queue.enqueue('a');
    await queue.enqueue('b');

    for (
      let i = 0;
      i < 60 && (finished.length < 2 || queue.pendingCount() > 0);
      i += 1
    )
      await tick(5);

    expect(finished).toEqual(['a', 'b']);
    expect(started).toEqual(['a', 'b']);
    expect(maxActive).toBe(1);
  });

  it('no-ops gracefully when no processor is registered', async () => {
    await expect(queue.enqueue('a')).resolves.toBeUndefined();
    // Nothing is drained and nothing throws; the job simply stays queued.
    expect(queue.pendingCount()).toBe(1);
  });
});
