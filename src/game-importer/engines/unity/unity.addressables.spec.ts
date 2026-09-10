import { SourcePolicyService } from '../../core/source-policy';
import { SecureDownloader } from '../../core/downloader';
import { DiagnosticCode } from '../../core/diagnostics';
import { UnityStreamingAssetsDiscovery } from './unity.streaming-assets-discovery';
import {
  ADDRESSABLES_SETTINGS_SUFFIX,
  addressablesPackagePath,
  catalogCandidates,
  catalogPackagePath,
  expandRuntimePath,
  extractCatalogInternalIds,
  extractCatalogLocations,
  hashSidecarUrl,
  hasUnityBundleMagic,
  isAddressablesCatalog,
  isAddressablesSettings,
  mentionsAddressables,
  rewriteCatalogIds,
} from './unity.addressables';

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.SOURCE_ALLOWED_HOSTS = 'cdn.example';
  process.env.ALLOW_ANY_HTTPS = 'false';
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

const CATALOG_URL = 'https://cdn.example/g/90/StreamingAssets/aa/settings.json';

function catalogJson(ids: unknown[]): string {
  return JSON.stringify({
    m_LocatorId: 'test',
    m_ResourceLocators: [
      {
        m_LocatorId: 'loc-0',
        m_Keys: ['key-a'],
        m_Entries: ids.map((id) => ({ m_InternalId: id })),
      },
    ],
  });
}

describe('unity addressables pure helpers', () => {
  it('detects Addressables signals without execution', () => {
    expect(
      mentionsAddressables('function x(){Module.streamingAssetsUrl}y'),
    ).toBe(false);
    expect(mentionsAddressables('Unity.Addressables init')).toBe(true);
    expect(mentionsAddressables('load aa/settings.json now')).toBe(true);
    expect(mentionsAddressables('ResourceManagerRuntimeData here')).toBe(true);
  });

  it('extracts internal IDs, skipping junk', () => {
    const ids = extractCatalogInternalIds(
      JSON.parse(
        catalogJson([
          'https://cdn.example/g/90/StreamingAssets/aa/Android/x.bundle',
          'aa/Android/y.bundle',
          'https://cdn.example/g/90/StreamingAssets/aa/Android/x.bundle',
          42,
          null,
          '   ',
        ]),
      ),
    );
    expect(ids).toEqual([
      'https://cdn.example/g/90/StreamingAssets/aa/Android/x.bundle',
      'aa/Android/y.bundle',
    ]);
  });

  it('rejects non-catalog shapes', () => {
    expect(extractCatalogInternalIds(null)).toEqual([]);
    expect(extractCatalogInternalIds('nope')).toEqual([]);
    expect(extractCatalogInternalIds({})).toEqual([]);
    expect(extractCatalogInternalIds({ m_ResourceLocators: 'nope' })).toEqual(
      [],
    );
  });

  it('extracts internal IDs from the packed v1.x ContentCatalogData shape', () => {
    const ids = extractCatalogInternalIds({
      m_LocatorId: 'AddressablesMainContentCatalog',
      m_InternalIds: [
        '{UnityEngine.AddressableAssets.Addressables.RuntimePath}/WebGL/a.bundle',
        '{UnityEngine.AddressableAssets.Addressables.RuntimePath}/WebGL/a.bundle',
        'Assets/Levels/0.prefab',
        42,
      ],
      m_KeyDataString: 'AAAA',
    });
    expect(ids).toEqual([
      '{UnityEngine.AddressableAssets.Addressables.RuntimePath}/WebGL/a.bundle',
      'Assets/Levels/0.prefab',
    ]);
  });

  it('extracts catalog locations from RuntimeData settings.json', () => {
    const locs = extractCatalogLocations({
      m_buildTarget: 'WebGL',
      m_CatalogLocations: [
        {
          m_Keys: ['AddressablesMainContentCatalog'],
          m_InternalId:
            '{UnityEngine.AddressableAssets.Addressables.RuntimePath}/catalog.json',
        },
      ],
      m_AddressablesVersion: '1.22.3',
    });
    expect(locs).toEqual([
      '{UnityEngine.AddressableAssets.Addressables.RuntimePath}/catalog.json',
    ]);
  });

  it('classifies Addressables payload shapes', () => {
    expect(isAddressablesSettings({ m_CatalogLocations: [] })).toBe(true);
    expect(
      isAddressablesSettings({
        m_CatalogLocations: [],
        m_ResourceLocators: [],
      }),
    ).toBe(false);
    expect(isAddressablesSettings({})).toBe(false);
    expect(isAddressablesCatalog({ m_ResourceLocators: [] })).toBe(true);
    expect(isAddressablesCatalog({ m_InternalIds: [] })).toBe(true);
    expect(isAddressablesCatalog({ m_CatalogLocations: [] })).toBe(false);
    expect(isAddressablesCatalog(null)).toBe(false);
  });

  it('expands Unity runtime-path placeholders to the aa/ directory', () => {
    expect(
      expandRuntimePath(
        '{UnityEngine.AddressableAssets.Addressables.RuntimePath}/WebGL/a.bundle',
        'https://cdn.example/g/90/StreamingAssets/aa',
      ),
    ).toBe('https://cdn.example/g/90/StreamingAssets/aa/WebGL/a.bundle');
    expect(
      expandRuntimePath(
        '{UnityEngine.AddressableAssets.Addressables.RuntimePath}/catalog.json',
        'https://cdn.example/g/90/StreamingAssets/aa/',
      ),
    ).toBe('https://cdn.example/g/90/StreamingAssets/aa/catalog.json');
    // No placeholder → unchanged.
    expect(
      expandRuntimePath('aa/Android/ember.bundle', 'https://cdn.example/aa/'),
    ).toBe('aa/Android/ember.bundle');
  });

  it('maps catalog/entry URLs to canonical package paths', () => {
    expect(
      addressablesPackagePath(
        'https://cdn.example/g/90/StreamingAssets/aa/Android/x.bundle?v=1',
      ),
    ).toBe('StreamingAssets/aa/Android/x.bundle');
    expect(
      addressablesPackagePath('https://cdn.example/other/x.bundle'),
    ).toBeNull();
    expect(
      addressablesPackagePath('https://cdn.example/g/90/StreamingAssets'),
    ).toBeNull();
    expect(addressablesPackagePath('file:///etc/passwd')).toBeNull();
    expect(
      addressablesPackagePath(
        'https://cdn.example/g/StreamingAssets/../evil.js',
      ),
    ).toBeNull();
  });

  it('derives the catalog package path with suffix preserved', () => {
    expect(catalogPackagePath(CATALOG_URL)).toBe(
      'StreamingAssets/aa/settings.json',
    );
    expect(
      catalogPackagePath(
        'https://cdn.example/g/90/StreamingAssets/aa/Android/settings.json',
      ),
    ).toBe('StreamingAssets/aa/Android/settings.json');
    expect(catalogPackagePath('https://cdn.example/x.json')).toBe(
      `StreamingAssets/${ADDRESSABLES_SETTINGS_SUFFIX}`,
    );
  });

  it('rewrites packaged IDs relative to the catalog', () => {
    const text = catalogJson([
      'https://cdn.example/g/90/StreamingAssets/aa/Android/x.bundle',
      'https://cdn.example/g/90/StreamingAssets/aa/Android/y.bundle',
    ]);
    const out = rewriteCatalogIds(
      text,
      'StreamingAssets/aa/settings.json',
      new Map([
        [
          'https://cdn.example/g/90/StreamingAssets/aa/Android/x.bundle',
          'StreamingAssets/aa/Android/x.bundle',
        ],
      ]),
    );
    expect(out).not.toBeNull();
    const back = JSON.parse(out as string);
    const ids = back.m_ResourceLocators[0].m_Entries.map(
      (e: { m_InternalId: string }) => e.m_InternalId,
    );
    // Packaged ID becomes catalog-relative; unpackaged stays verbatim.
    expect(ids).toContain('Android/x.bundle');
    expect(ids).toContain(
      'https://cdn.example/g/90/StreamingAssets/aa/Android/y.bundle',
    );
  });

  it('refuses to rewrite unparseable catalogs', () => {
    expect(
      rewriteCatalogIds(
        'not json',
        'StreamingAssets/aa/settings.json',
        new Map(),
      ),
    ).toBeNull();
    expect(
      rewriteCatalogIds('[]', 'StreamingAssets/aa/settings.json', new Map()),
    ).toBeNull();
    expect(
      rewriteCatalogIds('{}', 'StreamingAssets/aa/settings.json', new Map()),
    ).toBeNull();
  });

  it('builds candidate catalog URLs from signal and convention', () => {
    const urls = catalogCandidates(
      'https://cdn.example/g/90/StreamingAssets',
      'https://cdn.example/g/Build/loader.js',
    );
    expect(urls).toContain(
      'https://cdn.example/g/90/StreamingAssets/aa/settings.json',
    );
    // Conventional relative location, resolved against the build base.
    expect(urls).toContain(
      'https://cdn.example/g/Build/StreamingAssets/aa/settings.json',
    );
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe('unity addressables tree download', () => {
  function discoveryWith(
    bodies: Record<string, Buffer | Error>,
  ): UnityStreamingAssetsDiscovery {
    const downloader = {
      fetchBuffer: async (url: string) => {
        const hit = bodies[url];
        if (hit instanceof Error) throw hit;
        if (!hit) {
          const err = new Error(`Fake 404 for ${url}`);
          (err as { status?: number }).status = 404;
          throw err;
        }
        return { finalUrl: url, status: 200, body: hit, redirected: false };
      },
    } as unknown as SecureDownloader;
    return new UnityStreamingAssetsDiscovery(
      downloader,
      new SourcePolicyService(),
    );
  }

  const ENTRY_A =
    'https://cdn.example/g/90/StreamingAssets/aa/Android/a.bundle';
  const ENTRY_B = 'Android/b.bundle';

  it('downloads the catalog and its entries, rewriting packaged IDs', async () => {
    const d = discoveryWith({
      [CATALOG_URL]: Buffer.from(catalogJson([ENTRY_A, ENTRY_B])),
      [ENTRY_A]: Buffer.from('bundle-a'),
      'https://cdn.example/g/90/StreamingAssets/aa/Android/b.bundle':
        Buffer.from('bundle-b'),
    });
    const written = new Map<string, Buffer>();
    const res = await d.downloadAddressablesTree({
      candidateCatalogUrls: [CATALOG_URL],
      writeFile: async (p, bytes) => {
        written.set(p, bytes);
      },
    });
    expect(res.files.map((f) => f.path)).toContain(
      'StreamingAssets/aa/settings.json',
    );
    expect(res.files.map((f) => f.path)).toContain(
      'StreamingAssets/aa/Android/a.bundle',
    );
    expect(res.files.map((f) => f.path)).toContain(
      'StreamingAssets/aa/Android/b.bundle',
    );
    // Catalog is present and its IDs are rewritten to catalog-relative.
    const catalog = JSON.parse(
      (written.get('StreamingAssets/aa/settings.json') as Buffer).toString(
        'utf8',
      ),
    );
    const ids = catalog.m_ResourceLocators[0].m_Entries.map(
      (e: { m_InternalId: string }) => e.m_InternalId,
    );
    expect(ids).toContain('Android/a.bundle');
    expect(ids).toContain('Android/b.bundle');
    const codes = res.diagnostics.map((x) => x.code);
    expect(codes).toContain(DiagnosticCode.UNITY_ADDRESSABLES_CATALOG_FOUND);
    expect(codes).toContain(
      DiagnosticCode.UNITY_ADDRESSABLES_DISCOVERY_COMPLETED,
    );
  });

  it('handles two-stage bootstrap: settings.json → packed catalog → bundles', async () => {
    const SETTINGS_URL =
      'https://cdn.example/g/90/StreamingAssets/aa/settings.json';
    const CATALOG_URL_PACKED =
      'https://cdn.example/g/90/StreamingAssets/aa/catalog.json';
    const RT = '{UnityEngine.AddressableAssets.Addressables.RuntimePath}';
    const SETTINGS = JSON.stringify({
      m_buildTarget: 'WebGL',
      m_CatalogLocations: [{ m_InternalId: `${RT}/catalog.json` }],
      m_AddressablesVersion: '1.22.3',
    });
    const CATALOG = JSON.stringify({
      m_LocatorId: 'AddressablesMainContentCatalog',
      m_InternalIds: [
        `${RT}/WebGL/level_assets_all_x.bundle`,
        'Assets/Builtin/shaders',
        'Assets/Scenes/Game.unity',
      ],
    });
    const BUNDLE_ABS =
      'https://cdn.example/g/90/StreamingAssets/aa/WebGL/level_assets_all_x.bundle';
    const d = discoveryWith({
      [SETTINGS_URL]: Buffer.from(SETTINGS),
      [CATALOG_URL_PACKED]: Buffer.from(CATALOG),
      [BUNDLE_ABS]: Buffer.from('bundle-bytes'),
    });
    const written = new Map<string, Buffer>();
    const res = await d.downloadAddressablesTree({
      candidateCatalogUrls: [SETTINGS_URL],
      writeFile: async (p, bytes) => {
        written.set(p, bytes);
      },
    });
    // Settings, catalog, and the one .bundle file are packaged.
    expect(res.files.map((f) => f.path)).toContain(
      'StreamingAssets/aa/settings.json',
    );
    expect(res.files.map((f) => f.path)).toContain(
      'StreamingAssets/aa/catalog.json',
    );
    expect(res.files.map((f) => f.path)).toContain(
      'StreamingAssets/aa/WebGL/level_assets_all_x.bundle',
    );
    // Legacy Assets/... refs are skipped (no download attempt).
    expect(res.files.map((f) => f.path)).not.toContain(
      expect.stringContaining('Assets/'),
    );
    // Catalog is written verbatim (packed shape — no ID rewrite).
    const cat = JSON.parse(
      (written.get('StreamingAssets/aa/catalog.json') as Buffer).toString(
        'utf8',
      ),
    );
    expect(cat.m_InternalIds[0]).toBe(`${RT}/WebGL/level_assets_all_x.bundle`);
    // Settings is written verbatim.
    const st = JSON.parse(
      (written.get('StreamingAssets/aa/settings.json') as Buffer).toString(
        'utf8',
      ),
    );
    expect(st.m_AddressablesVersion).toBe('1.22.3');
    const codes = res.diagnostics.map((x) => x.code);
    expect(codes).toContain(DiagnosticCode.UNITY_ADDRESSABLES_SETTINGS_FOUND);
    expect(codes).toContain(DiagnosticCode.UNITY_ADDRESSABLES_CATALOG_FOUND);
    expect(codes).toContain(
      DiagnosticCode.UNITY_ADDRESSABLES_DISCOVERY_COMPLETED,
    );
  });

  it('packages bootstrap only when catalog location is unreachable', async () => {
    const SETTINGS_URL =
      'https://cdn.example/g/90/StreamingAssets/aa/settings.json';
    const RT = '{UnityEngine.AddressableAssets.Addressables.RuntimePath}';
    const SETTINGS = JSON.stringify({
      m_CatalogLocations: [{ m_InternalId: `${RT}/catalog.json` }],
    });
    const d = discoveryWith({
      [SETTINGS_URL]: Buffer.from(SETTINGS),
    });
    const written = new Map<string, Buffer>();
    const res = await d.downloadAddressablesTree({
      candidateCatalogUrls: [SETTINGS_URL],
      writeFile: async (p, bytes) => {
        written.set(p, bytes);
      },
    });
    expect(written.has('StreamingAssets/aa/settings.json')).toBe(true);
    expect(res.files.map((f) => f.path)).toContain(
      'StreamingAssets/aa/settings.json',
    );
    expect(res.diagnostics.map((x) => x.code)).toContain(
      DiagnosticCode.UNITY_ADDRESSABLES_CATALOG_MISSING,
    );
  });

  it('skips cleanly when no catalog is reachable', async () => {
    const d = discoveryWith({});
    const res = await d.downloadAddressablesTree({
      candidateCatalogUrls: [
        'https://cdn.example/g/90/StreamingAssets/aa/settings.json',
      ],
      writeFile: async () => {
        throw new Error('must not write');
      },
    });
    expect(res.files).toEqual([]);
    expect(res.diagnostics.map((x) => x.code)).toContain(
      DiagnosticCode.UNITY_ADDRESSABLES_CATALOG_MISSING,
    );
  });

  it('tries the next candidate when one is not a catalog', async () => {
    const d = discoveryWith({
      'https://cdn.example/a/aa/settings.json': Buffer.from('not json'),
      [CATALOG_URL]: Buffer.from(catalogJson([])),
    });
    const written = new Map<string, Buffer>();
    const res = await d.downloadAddressablesTree({
      candidateCatalogUrls: [
        'https://cdn.example/a/aa/settings.json',
        CATALOG_URL,
      ],
      writeFile: async (p, bytes) => {
        written.set(p, bytes);
      },
    });
    expect(written.has('StreamingAssets/aa/settings.json')).toBe(true);
    expect(res.files).toHaveLength(1);
  });

  it('skips policy-denied entries but keeps the rest', async () => {
    const d = discoveryWith({
      [CATALOG_URL]: Buffer.from(
        catalogJson([ENTRY_A, 'https://tracker.example/evil.bundle']),
      ),
      [ENTRY_A]: Buffer.from('bundle-a'),
    });
    const res = await d.downloadAddressablesTree({
      candidateCatalogUrls: [CATALOG_URL],
      writeFile: async () => undefined,
    });
    expect(res.files.map((f) => f.path)).toContain(
      'StreamingAssets/aa/Android/a.bundle',
    );
    expect(res.files.map((f) => f.path)).not.toContain(
      'StreamingAssets/evil.bundle',
    );
  });

  it('enforces the file cap', async () => {
    const ids = Array.from(
      { length: 10 },
      (_, i) => `https://cdn.example/g/90/StreamingAssets/aa/f${i}.bundle`,
    );
    const bodies: Record<string, Buffer | Error> = {
      [CATALOG_URL]: Buffer.from(catalogJson(ids)),
    };
    for (const id of ids) bodies[id] = Buffer.from('x');
    const d = discoveryWith(bodies);
    const res = await d.downloadAddressablesTree({
      candidateCatalogUrls: [CATALOG_URL],
      maxFiles: 3,
      writeFile: async () => undefined,
    });
    expect(res.limitReached).toBe(true);
    // 2 entries + rewritten catalog within a 3-file budget.
    expect(res.files.length).toBeLessThanOrEqual(3);
  });
});

describe('unity addressables bundle-catalogs and hash sidecars', () => {
  const SETTINGS_URL =
    'https://cdn.example/g/90/StreamingAssets/aa/settings.json';
  const RT = '{UnityEngine.AddressableAssets.Addressables.RuntimePath}';

  function settingsWithCatalogLocation(internalId: string): string {
    return JSON.stringify({
      m_CatalogLocations: [{ m_InternalId: internalId }],
    });
  }

  function discoveryWithHeaders(bodies: Record<string, Buffer | Error>): {
    d: UnityStreamingAssetsDiscovery;
    calls: Array<{ url: string; headers?: Record<string, string> }>;
  } {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const downloader = {
      fetchBuffer: async (
        url: string,
        opts?: { headers?: Record<string, string> },
      ) => {
        calls.push({ url, headers: opts?.headers });
        const hit = bodies[url];
        if (hit instanceof Error) throw hit;
        if (!hit) {
          const err = new Error(`Fake 404 for ${url}`);
          (err as { status?: number }).status = 404;
          throw err;
        }
        return { finalUrl: url, status: 200, body: hit, redirected: false };
      },
    } as unknown as SecureDownloader;
    return {
      d: new UnityStreamingAssetsDiscovery(
        downloader,
        new SourcePolicyService(),
      ),
      calls,
    };
  }

  it('sniffs Unity bundle magic instead of trusting extensions', () => {
    expect(hasUnityBundleMagic(Buffer.from('UnityFS........'))).toBe(true);
    expect(hasUnityBundleMagic(Buffer.from('UnityWeb-data'))).toBe(true);
    expect(hasUnityBundleMagic(Buffer.from('UnityRaw\x00\x01'))).toBe(true);
    expect(hasUnityBundleMagic(Buffer.from('{"m_LocatorId":'))).toBe(false);
    expect(hasUnityBundleMagic(Buffer.from('Unity'))).toBe(false);
    expect(hasUnityBundleMagic(Buffer.alloc(0))).toBe(false);
  });

  it('maps any catalog artifact name to its .hash sidecar', () => {
    expect(hashSidecarUrl('https://cdn.example/a/catalog.json')).toBe(
      'https://cdn.example/a/catalog.hash',
    );
    // Timestamped dynamic names (requested at runtime per build).
    expect(
      hashSidecarUrl(
        'https://cdn.example/g/StreamingAssets/aa/WebGL/catalog_2025.10.02.13.29.38.json',
      ),
    ).toBe(
      'https://cdn.example/g/StreamingAssets/aa/WebGL/catalog_2025.10.02.13.29.38.hash',
    );
    expect(hashSidecarUrl('https://cdn.example/a/catalog.bundle')).toBe(
      'https://cdn.example/a/catalog.hash',
    );
    expect(hashSidecarUrl('https://cdn.example/a/catalog.hash')).toBeNull();
    expect(hashSidecarUrl('https://cdn.example/a/noext')).toBeNull();
    expect(hashSidecarUrl('not a url')).toBeNull();
  });

  it('packages a binary bundle-catalog location verbatim plus its sidecar', async () => {
    const BUNDLE_URL =
      'https://cdn.example/g/90/StreamingAssets/aa/WebGL/catalog_2025.10.02.13.29.38.bundle';
    const HASH_URL =
      'https://cdn.example/g/90/StreamingAssets/aa/WebGL/catalog_2025.10.02.13.29.38.hash';
    const bundleBody = Buffer.concat([
      Buffer.from('UnityFS'),
      Buffer.from('binary-catalog-payload'),
    ]);
    const { d } = discoveryWithHeaders({
      [SETTINGS_URL]: Buffer.from(
        settingsWithCatalogLocation(
          `${RT}/WebGL/catalog_2025.10.02.13.29.38.bundle`,
        ),
      ),
      [BUNDLE_URL]: bundleBody,
      [HASH_URL]: Buffer.from('bundle-hash-1'),
    });
    const written = new Map<string, Buffer>();
    const res = await d.downloadAddressablesTree({
      candidateCatalogUrls: [SETTINGS_URL],
      writeFile: async (p, bytes) => {
        written.set(p, bytes);
      },
    });
    // Binary catalog packaged byte-identical (never JSON-parsed/rewritten).
    const pkgPath =
      'StreamingAssets/aa/WebGL/catalog_2025.10.02.13.29.38.bundle';
    expect(res.files.map((f) => f.path)).toContain(pkgPath);
    expect(written.get(pkgPath)).toEqual(bundleBody);
    // Its .hash sidecar travels with it (runtime update check).
    const hashPkgPath =
      'StreamingAssets/aa/WebGL/catalog_2025.10.02.13.29.38.hash';
    expect(res.files.map((f) => f.path)).toContain(hashPkgPath);
    expect(written.get(hashPkgPath)?.toString('utf8')).toBe('bundle-hash-1');
  });

  it('packages the .hash sidecar next to a JSON content catalog', async () => {
    const CATALOG_URL =
      'https://cdn.example/g/90/StreamingAssets/aa/catalog.json';
    const HASH_URL = 'https://cdn.example/g/90/StreamingAssets/aa/catalog.hash';
    const BUNDLE_URL =
      'https://cdn.example/g/90/StreamingAssets/aa/WebGL/x.bundle';
    const { d } = discoveryWithHeaders({
      [SETTINGS_URL]: Buffer.from(
        settingsWithCatalogLocation(`${RT}/catalog.json`),
      ),
      [CATALOG_URL]: Buffer.from(
        JSON.stringify({
          m_LocatorId: 'AddressablesMainContentCatalog',
          m_InternalIds: [`${RT}/WebGL/x.bundle`],
        }),
      ),
      [HASH_URL]: Buffer.from('catalog-hash-9'),
      [BUNDLE_URL]: Buffer.from('bundle-bytes'),
    });
    const written = new Map<string, Buffer>();
    const res = await d.downloadAddressablesTree({
      candidateCatalogUrls: [SETTINGS_URL],
      writeFile: async (p, bytes) => {
        written.set(p, bytes);
      },
    });
    const paths = res.files.map((f) => f.path);
    expect(paths).toContain('StreamingAssets/aa/settings.json');
    expect(paths).toContain('StreamingAssets/aa/catalog.json');
    expect(paths).toContain('StreamingAssets/aa/catalog.hash');
    expect(paths).toContain('StreamingAssets/aa/WebGL/x.bundle');
    expect(
      written.get('StreamingAssets/aa/catalog.hash')?.toString('utf8'),
    ).toBe('catalog-hash-9');
  });

  it('skips a missing sidecar silently (normal for local catalogs)', async () => {
    const CATALOG_URL =
      'https://cdn.example/g/90/StreamingAssets/aa/catalog.json';
    const { d } = discoveryWithHeaders({
      [SETTINGS_URL]: Buffer.from(
        settingsWithCatalogLocation(`${RT}/catalog.json`),
      ),
      [CATALOG_URL]: Buffer.from(
        JSON.stringify({
          m_LocatorId: 'AddressablesMainContentCatalog',
          m_InternalIds: [],
        }),
      ),
    });
    const written = new Map<string, Buffer>();
    const res = await d.downloadAddressablesTree({
      candidateCatalogUrls: [SETTINGS_URL],
      writeFile: async (p, bytes) => {
        written.set(p, bytes);
      },
    });
    expect(res.files.map((f) => f.path)).toContain(
      'StreamingAssets/aa/catalog.json',
    );
    expect(res.files.map((f) => f.path)).not.toContain(
      'StreamingAssets/aa/catalog.hash',
    );
  });

  it('sends the source page Referer on every addressables download', async () => {
    const ENTRY_BUNDLE =
      'https://cdn.example/g/90/StreamingAssets/aa/WebGL/x.bundle';
    const { d, calls } = discoveryWithHeaders({
      [CATALOG_URL]: Buffer.from(catalogJson([ENTRY_BUNDLE])),
      [ENTRY_BUNDLE]: Buffer.from('bundle-bytes'),
    });
    await d.downloadAddressablesTree({
      candidateCatalogUrls: [CATALOG_URL],
      writeFile: async () => undefined,
      referer: 'https://portal.example/game',
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.headers).toEqual({ Referer: 'https://portal.example/game' });
    }
  });

  it('sends the source page Referer on streaming-assets downloads', async () => {
    const URL_A = 'https://cdn.example/g/90/StreamingAssets/aa/a.bundle';
    const { d, calls } = discoveryWithHeaders({
      [URL_A]: Buffer.from('bytes'),
    });
    const res = await d.downloadAll(
      [{ url: URL_A, path: 'StreamingAssets/aa/a.bundle' }],
      {
        writeFile: async () => undefined,
        referer: 'https://portal.example/game',
      },
    );
    expect(res.files).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toEqual({
      Referer: 'https://portal.example/game',
    });
  });
});
