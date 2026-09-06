import { Injectable } from '@nestjs/common';

/**
 * SourcePolicy enforces that the importer only fetches sources the platform
 * is authorized to redistribute. Allowlist is checked BEFORE any download.
 *
 * Configure via:
 *  - SOURCE_ALLOWED_HOSTS: comma-separated host allowlist
 *  - ALLOW_ANY_HTTPS: if 'true', any https URL passes the allowlist check
 *    (NOT recommended for production; SSRF checks still apply).
 */
@Injectable()
export class SourcePolicyService {
  private allowedHosts(): string[] {
    const raw = process.env.SOURCE_ALLOWED_HOSTS ?? '';
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  private allowAnyHttps(): boolean {
    return (process.env.ALLOW_ANY_HTTPS ?? 'false').toLowerCase() === 'true';
  }

  isAllowed(sourceUrl: string): { allowed: boolean; reason?: string } {
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      return { allowed: false, reason: 'Malformed URL' };
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {
        allowed: false,
        reason: `Unsupported protocol: ${parsed.protocol}`,
      };
    }
    const host = parsed.hostname.toLowerCase();
    if (this.allowedHosts().includes(host)) return { allowed: true };
    if (this.allowAnyHttps() && parsed.protocol === 'https:') {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Host not allowlisted: ${host}. Only authorized redistribution sources may be imported.`,
    };
  }

  assertAllowed(sourceUrl: string): void {
    const res = this.isAllowed(sourceUrl);
    if (!res.allowed) {
      throw new SourceNotAllowedError(res.reason ?? 'Source not allowed');
    }
  }
}

export class SourceNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceNotAllowedError';
  }
}
