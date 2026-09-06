import { Injectable } from '@nestjs/common';
import {
  SourcePolicyService,
  SourceNotAllowedError,
} from '../core/source-policy';

/**
 * Adapter-facing authorization gate. Wraps the global {@link SourcePolicyService}
 * so source adapters depend on a single, explicit contract: every URL must be
 * authorized for redistribution BEFORE it is fetched, and every post-redirect
 * (final) URL must be re-checked. SSRF enforcement itself stays inside
 * `SecureDownloader` / `core/ssrf.ts`.
 */
@Injectable()
export class AuthorizedSourcePolicy {
  constructor(private readonly policy: SourcePolicyService) {}

  isAuthorized(url: string): boolean {
    return this.policy.isAllowed(url).allowed;
  }

  assertAuthorized(url: string): void {
    try {
      this.policy.assertAllowed(url);
    } catch (err) {
      if (err instanceof SourceNotAllowedError) throw err;
      throw new SourceNotAllowedError((err as Error).message);
    }
  }
}
