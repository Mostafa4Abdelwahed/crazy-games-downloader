import { Inject, Injectable } from '@nestjs/common';
import { GameSourceAdapter } from './source.interface';

/**
 * Registry of source/platform adapters. The worker asks the registry for
 * the first adapter whose `canHandle()` matches; when none matches, the
 * pipeline falls back to the legacy direct-fetch path.
 */
@Injectable()
export class SourceRegistry {
  constructor(
    @Inject('SOURCE_ADAPTERS')
    private readonly adapters: GameSourceAdapter[],
  ) {}

  findAdapter(url: string): GameSourceAdapter | null {
    for (const adapter of this.adapters) {
      try {
        if (adapter.canHandle(url)) return adapter;
      } catch {
        // A broken predicate must never break routing; try the next adapter.
        continue;
      }
    }
    return null;
  }

  list(): string[] {
    return this.adapters.map((a) => a.name);
  }
}
