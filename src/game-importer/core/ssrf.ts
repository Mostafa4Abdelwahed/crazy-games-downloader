import * as dns from 'node:dns/promises';
import * as net from 'node:net';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const CLOUD_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.com',
  'instance-data',
  'instance-data.compute.internal',
]);

const CLOUD_METADATA_IPS = new Set(['169.254.169.254', 'fd00:ec2::254']);

function ipToBigInt(ip: string): bigint | null {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    let v = 0n;
    for (const p of parts) v = (v << 8n) + BigInt(p);
    return v;
  }
  if (net.isIPv6(ip)) {
    // Expand :: shorthand
    const [head, tail] = ip.split('::');
    const headParts = head ? head.split(':').filter(Boolean) : [];
    const tailParts = tail ? tail.split(':').filter(Boolean) : [];
    const missing = 8 - headParts.length - tailParts.length;
    const full = [...headParts, ...Array(missing).fill('0'), ...tailParts];
    let v = 0n;
    for (const p of full) v = (v << 16n) + BigInt(parseInt(p || '0', 16));
    return v;
  }
  return null;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipV = ipToBigInt(ip);
  const baseV = ipToBigInt(base);
  if (ipV === null || baseV === null) return false;
  const width = net.isIPv6(base) ? 128 : 32;
  const shift = BigInt(width - bits);
  return ipV >> shift === baseV >> shift;
}

const PRIVATE_RANGES = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '0.0.0.0/8',
  '100.64.0.0/10',
  '192.0.2.0/24',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  '::/128',
  '::ffff:0:0/96',
];

export function isBlockedIp(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (CLOUD_METADATA_IPS.has(normalized)) return true;
  if (net.isIP(normalized) === 0) return false;
  // Block loopback explicitly
  if (normalized === '127.0.0.1' || normalized === '::1') return true;
  for (const cidr of PRIVATE_RANGES) {
    try {
      if (inCidr(normalized, cidr)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Validate a URL string for SSRF safety (synchronous part: protocol/host shape).
 * Full validation including DNS resolution is done in {@link assertUrlSafe}.
 */
export function validateUrlShape(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Malformed URL: ${rawUrl}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SsrfError(
      `Unsupported protocol "${parsed.protocol}". Only http/https allowed.`,
    );
  }
  const rawHost = parsed.hostname.toLowerCase();
  // WHATWG URL keeps brackets on IPv6 literals (e.g. "[::1]") — strip them.
  const host = rawHost.replace(/^\[(.*)\]$/, '$1');
  if (!host) throw new SsrfError('URL has empty hostname');
  if (host === 'localhost') throw new SsrfError('localhost is blocked');
  if (CLOUD_METADATA_HOSTS.has(host)) {
    throw new SsrfError('Cloud metadata endpoint blocked');
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new SsrfError(`Blocked IP address: ${host}`);
  }
  if (parsed.username || parsed.password) {
    throw new SsrfError('URLs with embedded credentials are blocked');
  }
  return parsed;
}

export type DnsResolver = (host: string) => Promise<string[]>;

/**
 * Fully validate a URL against SSRF: shape + DNS resolution of hostname.
 * Every redirect target must be revalidated with this function.
 */
export async function assertUrlSafe(
  rawUrl: string,
  resolver: DnsResolver = defaultResolver,
): Promise<URL> {
  const parsed = validateUrlShape(rawUrl);
  const host = parsed.hostname;
  if (net.isIP(host)) return parsed; // already checked literal
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new SsrfError(`DNS resolution failed for host: ${host}`);
  }
  if (!addresses.length) throw new SsrfError(`No DNS records for: ${host}`);
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new SsrfError(
        `Host resolves to blocked address: ${host} -> ${addr}`,
      );
    }
  }
  return parsed;
}

async function defaultResolver(host: string): Promise<string[]> {
  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(host),
    dns.resolve6(host),
  ]);
  const out: string[] = [];
  if (v4.status === 'fulfilled') out.push(...v4.value);
  if (v6.status === 'fulfilled') out.push(...v6.value);
  return out;
}

/** Validate that a redirect target is safe (re-resolves DNS). */
export async function validateRedirect(
  fromUrl: string,
  locationHeader: string,
  resolver?: DnsResolver,
): Promise<string> {
  void fromUrl;
  const next = new URL(locationHeader, fromUrl).toString();
  await assertUrlSafe(next, resolver);
  return next;
}
