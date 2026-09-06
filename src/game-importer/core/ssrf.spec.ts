import {
  assertUrlSafe,
  isBlockedIp,
  validateRedirect,
  validateUrlShape,
} from './ssrf';

const publicResolver = async () => ['93.184.216.34']; // example.com
const privateResolver = async () => ['10.1.2.3'];

describe('SSRF protection', () => {
  it('blocks localhost and loopback literals', () => {
    expect(() => validateUrlShape('http://localhost/game')).toThrow();
    expect(() => validateUrlShape('http://127.0.0.1/game')).toThrow();
    expect(() => validateUrlShape('http://[::1]/game')).toThrow();
  });

  it('blocks private ranges', () => {
    expect(isBlockedIp('10.0.0.5')).toBe(true);
    expect(isBlockedIp('192.168.1.1')).toBe(true);
    expect(isBlockedIp('172.16.5.4')).toBe(true);
    expect(isBlockedIp('169.254.169.254')).toBe(true);
    expect(isBlockedIp('93.184.216.34')).toBe(false);
  });

  it('blocks file:// and unsupported protocols', () => {
    expect(() => validateUrlShape('file:///etc/passwd')).toThrow();
    expect(() => validateUrlShape('ftp://example.com/x')).toThrow();
    expect(() => validateUrlShape('gopher://example.com/x')).toThrow();
  });

  it('blocks cloud metadata endpoints', () => {
    expect(() =>
      validateUrlShape('http://metadata.google.internal/x'),
    ).toThrow();
    expect(() => validateUrlShape('http://169.254.169.254/x')).toThrow();
  });

  it('rejects hosts resolving to private IPs', async () => {
    await expect(
      assertUrlSafe('https://internal.example/game', privateResolver),
    ).rejects.toThrow(/blocked/i);
  });

  it('allows public hosts', async () => {
    const url = await assertUrlSafe(
      'https://partner.example/game',
      publicResolver,
    );
    expect(url.hostname).toBe('partner.example');
  });

  it('revalidates every redirect target', async () => {
    // redirect to private IP must be rejected
    await expect(
      validateRedirect(
        'https://partner.example/a',
        'http://10.0.0.5/evil',
        publicResolver,
      ),
    ).rejects.toThrow();
    // redirect to public host passes
    const next = await validateRedirect(
      'https://partner.example/a',
      'https://cdn.example/b',
      publicResolver,
    );
    expect(next).toBe('https://cdn.example/b');
  });
});
