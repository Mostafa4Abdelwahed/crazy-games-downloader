import { SourcePolicyService } from './source-policy';

describe('SourcePolicy', () => {
  const OLD = process.env;

  beforeEach(() => {
    process.env = { ...OLD };
  });
  afterAll(() => {
    process.env = OLD;
  });

  it('allows allowlisted hosts', () => {
    process.env.SOURCE_ALLOWED_HOSTS = 'partner.example, cdn.example';
    process.env.ALLOW_ANY_HTTPS = 'false';
    const svc = new SourcePolicyService();
    expect(svc.isAllowed('https://partner.example/game').allowed).toBe(true);
    expect(svc.isAllowed('https://evil.example/game').allowed).toBe(false);
  });

  it('rejects non-allowlisted hosts with redistribution-rights reason', () => {
    process.env.SOURCE_ALLOWED_HOSTS = 'partner.example';
    process.env.ALLOW_ANY_HTTPS = 'false';
    const svc = new SourcePolicyService();
    const res = svc.isAllowed('https://random-site.example/game');
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/allowlist|authorized/i);
  });

  it('rejects non-http protocols before download', () => {
    process.env.SOURCE_ALLOWED_HOSTS = 'partner.example';
    const svc = new SourcePolicyService();
    expect(() => svc.assertAllowed('file:///etc/passwd')).toThrow();
  });
});
