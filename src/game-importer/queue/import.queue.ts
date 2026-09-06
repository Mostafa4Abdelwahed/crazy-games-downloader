import { Injectable, Logger } from '@nestjs/common';

/**
 * Import queue abstraction.
 *
 * - `bullmq` driver: real BullMQ + Redis (production).
 * - `memory` driver: in-process async queue (dev/test, no Redis needed).
 *
 * The worker processor is injected via `setProcessor` to avoid circular deps.
 */
export type QueueDriver = 'bullmq' | 'memory';

@Injectable()
export class ImportQueueService {
  private readonly logger = new Logger(ImportQueueService.name);
  private processor: ((jobId: string) => Promise<void>) | null = null;
  private bullmqQueue: any = null;
  private readonly driver: QueueDriver;

  constructor() {
    const hasRedis = Boolean(process.env.REDIS_URL);
    const want = process.env.QUEUE_DRIVER ?? (hasRedis ? 'bullmq' : 'memory');
    this.driver = want === 'bullmq' && hasRedis ? 'bullmq' : 'memory';
    if (this.driver === 'bullmq') {
      this.initBullMq();
    }
  }

  private initBullMq() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Queue } = require('bullmq');
      this.bullmqQueue = new Queue('game-imports', {
        connection: { url: process.env.REDIS_URL },
      });
    } catch (err) {
      this.logger.warn(
        `BullMQ unavailable, falling back to memory queue: ${(err as Error).message}`,
      );
      (this as any).driver = 'memory';
    }
  }

  setProcessor(fn: (jobId: string) => Promise<void>) {
    this.processor = fn;
  }

  getDriver(): QueueDriver {
    return this.driver;
  }

  async enqueue(jobId: string): Promise<void> {
    if (this.driver === 'bullmq' && this.bullmqQueue) {
      await this.bullmqQueue.add('import', { jobId });
      return;
    }
    // memory driver: process async in background tick
    const proc = this.processor;
    if (!proc) {
      this.logger.warn(`No processor registered; job ${jobId} stays queued`);
      return;
    }
    setImmediate(() => {
      proc(jobId).catch((err) =>
        this.logger.error(`Memory queue job ${jobId} failed: ${err?.message}`),
      );
    });
  }
}
