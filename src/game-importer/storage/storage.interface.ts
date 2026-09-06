/**
 * Pluggable storage backend for finished game packages.
 * LocalStorage is implemented first; S3/R2 adapter (Milestone 3) must
 * implement this same interface.
 */
export interface GameStorage {
  /**
   * Recursively upload a local directory to a destination prefix.
   * @returns public/serve URL or storage URI for the uploaded package.
   */
  upload(localPath: string, destination: string): Promise<string>;
}
