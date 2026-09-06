import { Injectable } from '@nestjs/common';
import { GameStorage } from './storage.interface';
import { LocalStorage } from './local.storage';

/**
 * Storage factory. Milestone 3 adds the S3/R2 adapter behind STORAGE_DRIVER=s3.
 */
@Injectable()
export class StorageFactory {
  create(driver: string = process.env.STORAGE_DRIVER ?? 'local'): GameStorage {
    if (driver === 'local') return new LocalStorage();
    if (driver === 's3') {
      throw new Error(
        'S3/R2 storage adapter is Milestone 3 — not yet configured. Set STORAGE_DRIVER=local.',
      );
    }
    throw new Error(`Unknown storage driver: ${driver}`);
  }
}
