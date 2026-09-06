import { Injectable } from '@nestjs/common';

/**
 * High-level import pipeline facade (core/importer.ts).
 * The BullMQ worker ({@link ImportWorker}) drives the actual steps; this
 * service documents the canonical workflow and exposes progress shape:
 *
 * POST /game-imports -> create ImportJob -> validate SourcePolicy ->
 * enqueue -> worker(source adapter -> fetch -> detect -> engine import ->
 * download -> decompress -> validate -> upload) -> complete.
 */
@Injectable()
export class GameImporterService {
  describeWorkflow(): string[] {
    return [
      'create ImportJob',
      'validate SourcePolicy',
      'enqueue BullMQ job',
      'resolve source adapter',
      'fetch authorized source',
      'detect engine',
      'engine-specific importer',
      'download assets',
      'decompress supported formats',
      'validate package',
      'upload to storage',
      'complete',
    ];
  }
}
