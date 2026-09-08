import * as fs from 'node:fs';
import * as path from 'node:path';
import { SecureDownloader } from '../../core/downloader';
import {
  SourcePolicyService,
  SourceNotAllowedError,
} from '../../core/source-policy';
import { AuthorizedSourcePolicy } from '../authorized-source-policy';
import { SourceRedirectedError } from '../source.interface';
import { CrazyGamesParser } from './crazygames.parser';
import { CrazyGamesSourceAdapter } from './crazygames.source';

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name: string): Buffer =>
  fs.readFileSync(path.join(FIXTURES, name));

interface FakeEntry {
  body: Buffer;
  finalUrl?: string;
}

/** SSRF-safe fake: no network, exact-URL map, redirect simulation via finalUrl. */
function fakeDownloader(map: Record<string, FakeEntry>) {
  const calls: string[] = [];
  const fake = {
    calls,
    fetchBuffer: async (url: string) => {
      calls.push(url);
      const hit = map[url];
      if (!hit) throw new Error(`Fake 404 for ${url}`);
      return {
        finalUrl: hit.finalUrl ?? url,
        status: 200,
        contentType: 'text/html',
        body: hit.body,
        redirected: Boolean(hit.finalUrl && hit.finalUrl !== url),
      };
    },
  };
  return fake;
}

function buildAdapter(
  map: Record<string, FakeEntry>,
  allowedHosts = 'www.crazygames.com,games.crazygames.com',
) {
  const OLD = process.env.SOURCE_ALLOWED_HOSTS;
  process.env.SOURCE_ALLOWED_HOSTS = allowedHosts;
  process.env.ALLOW_ANY_HTTPS = 'false';
  const downloader = fakeDownloader(map);
  const adapter = new CrazyGamesSourceAdapter(
    new CrazyGamesParser(),
    downloader as unknown as SecureDownloader,
    new AuthorizedSourcePolicy(new SourcePolicyService()),
  );
  return {
    adapter,
    downloader,
    restore: () => {
      if (OLD === undefined) delete process.env.SOURCE_ALLOWED_HOSTS;
      else process.env.SOURCE_ALLOWED_HOSTS = OLD;
    },
  };
}

const UNITY_MAP: Record<string, FakeEntry> = {
  'https://www.crazygames.com/game/space-adventure': {
    body: read('unity-page.html'),
  },
  'https://games.crazygames.com/en_US/space-adventure/index.html': {
    body: read('unity-frame.html'),
  },
};

describe('CrazyGamesSourceAdapter canHandle', () => {
  const { adapter, restore } = buildAdapter({});
  afterAll(restore);

  it('handles CrazyGames game URLs', () => {
    expect(
      adapter.canHandle('https://www.crazygames.com/game/space-adventure'),
    ).toBe(true);
    expect(
      adapter.canHandle('https://games.crazygames.com/en_US/some-game/x'),
    ).toBe(true);
    expect(adapter.canHandle('https://crazygames.com/game/x')).toBe(true);
  });

  it('rejects other hosts and malformed URLs without I/O', () => {
    expect(adapter.canHandle('https://partner.example/games/demo')).toBe(false);
    expect(adapter.canHandle('https://evil-crazygames.com/game/x')).toBe(false);
    expect(adapter.canHandle('not a url')).toBe(false);
  });
});

describe('CrazyGamesSourceAdapter resolve', () => {
  it('resolves a Unity page to game entry + asset hints + metadata', async () => {
    const { adapter, restore } = buildAdapter(UNITY_MAP);
    try {
      const resolved = await adapter.resolve(
        'https://www.crazygames.com/game/space-adventure',
        {},
      );
      expect(resolved.source).toBe('crazygames');
      expect(resolved.canonicalUrl).toBe(
        'https://www.crazygames.com/game/space-adventure',
      );
      expect(resolved.gameUrl).toBe(
        'https://games.crazygames.com/en_US/space-adventure/index.html',
      );
      expect(resolved.entryUrl).toBe(
        'https://games.crazygames.com/en_US/space-adventure/index.html',
      );
      expect(resolved.assetUrls).toContain(
        'https://games.crazygames.com/en_US/space-adventure/Build/space-adventure.loader.js',
      );
      expect(resolved.metadata?.title).toBe('Space Adventure');
      expect(resolved.metadata?.thumbnail).toContain('thumb.png');
    } finally {
      restore();
    }
  });

  it('resolves Brotli and alt-filename Unity layouts without hardcoding names', async () => {
    const { adapter, restore } = buildAdapter({
      'https://www.crazygames.com/game/pixel-racer': {
        body: read('unity-br-page.html'),
      },
      'https://games.crazygames.com/en_US/pixel-racer/index.html': {
        body: read('unity-br-frame.html'),
      },
      'https://www.crazygames.com/game/ninja-run': {
        body: read('unity-alt-page.html'),
      },
      'https://games.crazygames.com/en_US/ninja-run/index.html': {
        body: read('unity-alt-frame.html'),
      },
    });
    try {
      const br = await adapter.resolve(
        'https://www.crazygames.com/game/pixel-racer',
        {},
      );
      expect(br.entryUrl).toContain('pixel-racer');
      expect(br.assetUrls).toContain(
        'https://games.crazygames.com/en_US/pixel-racer/Build/pixel-racer.loader.js',
      );

      const alt = await adapter.resolve(
        'https://www.crazygames.com/game/ninja-run',
        {},
      );
      expect(alt.entryUrl).toContain('ninja-run');
      expect(alt.assetUrls).toContain(
        'https://games.crazygames.com/en_US/ninja-run/webgl/Build/ninja-run.loader.js',
      );
    } finally {
      restore();
    }
  });

  it('resolves generic HTML5 pages without forcing Unity', async () => {
    const { adapter, restore } = buildAdapter({
      'https://www.crazygames.com/game/jewel-quest': {
        body: read('html5-page.html'),
      },
      'https://games.crazygames.com/en_US/jewel-quest/index.html': {
        body: read('html5-frame.html'),
      },
    });
    try {
      const resolved = await adapter.resolve(
        'https://www.crazygames.com/game/jewel-quest',
        {},
      );
      expect(resolved.entryUrl).toContain('jewel-quest');
      expect(resolved.assetUrls.join('\n')).not.toMatch(/loader\.js/i);
      expect(resolved.assetUrls).toContain(
        'https://games.crazygames.com/en_US/jewel-quest/js/main.js',
      );
    } finally {
      restore();
    }
  });

  it('returns a best-effort source for unsupported layouts', async () => {
    const { adapter, restore } = buildAdapter({
      'https://www.crazygames.com/top-10-space-games': {
        body: read('unsupported-page.html'),
      },
    });
    try {
      const resolved = await adapter.resolve(
        'https://www.crazygames.com/top-10-space-games',
        {},
      );
      expect(resolved.source).toBe('crazygames');
      expect(resolved.gameUrl).toBeUndefined();
      expect(resolved.entryUrl).toBeUndefined();
      expect(resolved.assetUrls).toEqual([]);
      expect(resolved.metadata?.title).toBe('Top 10 Space Games');
    } finally {
      restore();
    }
  });

  it('rejects non-allowlisted URLs via SourcePolicy before fetching', async () => {
    const { adapter, downloader, restore } = buildAdapter(UNITY_MAP, '');
    try {
      await expect(
        adapter.resolve('https://www.crazygames.com/game/space-adventure', {}),
      ).rejects.toBeInstanceOf(SourceNotAllowedError);
      expect(downloader.calls).toEqual([]);
    } finally {
      restore();
    }
  });

  it('rejects redirects that leave the platform', async () => {
    const { adapter, restore } = buildAdapter(
      {
        'https://www.crazygames.com/game/space-adventure': {
          body: read('unity-page.html'),
          finalUrl: 'https://evil.example/clone',
        },
      },
      'www.crazygames.com,games.crazygames.com,evil.example',
    );
    try {
      await expect(
        adapter.resolve('https://www.crazygames.com/game/space-adventure', {}),
      ).rejects.toBeInstanceOf(SourceRedirectedError);
    } finally {
      restore();
    }
  });

  it('refuses access-restricted pages instead of bypassing', async () => {
    const { adapter, restore } = buildAdapter({
      'https://www.crazygames.com/game/locked': {
        body: Buffer.from(
          '<html><head><title>Locked</title></head><body>Please log in to continue</body></html>',
        ),
      },
    });
    try {
      await expect(
        adapter.resolve('https://www.crazygames.com/game/locked', {}),
      ).rejects.toThrow(/restricted access/i);
    } finally {
      restore();
    }
  });
});

describe('CrazyGamesSourceAdapter listGames', () => {
  const LISTING_MAP: Record<string, FakeEntry> = {
    'https://www.crazygames.com/c/action': {
      body: read('listing-page.html'),
    },
  };

  it('discovers canonical game links from a listing page', async () => {
    const { adapter, downloader, restore } = buildAdapter(LISTING_MAP);
    try {
      const { games } = await adapter.listGames(
        'https://www.crazygames.com/c/action',
        {},
      );
      expect(games).toHaveLength(4);
      expect(games[0]).toEqual({
        url: 'https://www.crazygames.com/game/space-adventure',
        title: 'Space Adventure',
        thumbnail: 'https://images.crazygames.com/space-adventure/thumb.png',
      });
      expect(games[2]).toEqual({
        url: 'https://www.crazygames.com/game/neo-console',
        title: 'Neo Console',
        thumbnail: 'https://www.crazygames.com/assets/neo-console/thumb.jpg',
      });
      expect(downloader.calls).toEqual(['https://www.crazygames.com/c/action']);
    } finally {
      restore();
    }
  });

  it('explains an empty listing instead of returning a cryptic empty array', async () => {
    const { adapter, restore } = buildAdapter({
      'https://www.crazygames.com/c/none': {
        body: Buffer.from(
          '<html><head><title>Games We Like</title></head>' +
            '<body><a href="/about">About</a></body></html>',
        ),
      },
    });
    try {
      const res = await adapter.listGames(
        'https://www.crazygames.com/c/none',
        {},
      );
      expect(res.games).toEqual([]);
      expect(res.note).toContain('Games We Like');
      expect(res.note).toContain('none pointed at /game/{slug}');
    } finally {
      restore();
    }
  });

  it('reads the full grid from __NEXT_DATA__ when anchors only mention a few', async () => {
    const nextData =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({
        props: {
          pageProps: {
            games: {
              pagination: { page: 1, size: 60 },
              total: 717,
              items: [
                {
                  name: 'War the Knights',
                  slug: 'war-the-knights',
                  cover: 'wc_16x9/c/x-cover',
                },
                { name: 'Run 3', slug: 'run-3' },
              ],
            },
          },
        },
      }) +
      '</script>';
    const { adapter, restore } = buildAdapter({
      'https://www.crazygames.com/c/action': {
        body: Buffer.from(
          '<html><head><title>Action Games</title></head>' +
            '<body>' +
            nextData +
            '<a href="/game/war-the-knights"><span>War the Knights</span></a></body></html>',
        ),
      },
    });
    try {
      const res = await adapter.listGames(
        'https://www.crazygames.com/c/action',
        {},
      );
      expect(res.games).toHaveLength(2);
      expect(res.games[0]).toEqual({
        url: 'https://www.crazygames.com/game/war-the-knights',
        title: 'War the Knights',
        thumbnail:
          'https://images.crazygames.com/wc_16x9/c/x-cover?format=auto&quality=100&metadata=none&width=480&height=270',
      });
      expect(res.games[1]).toEqual({
        url: 'https://www.crazygames.com/game/run-3',
        title: 'Run 3',
      });
    } finally {
      restore();
    }
  });

  it('rejects a listing URL that is not allowlisted before fetching', async () => {
    const { adapter, downloader, restore } = buildAdapter(LISTING_MAP, '');
    try {
      await expect(
        adapter.listGames('https://www.crazygames.com/c/action', {}),
      ).rejects.toBeInstanceOf(SourceNotAllowedError);
      expect(downloader.calls).toEqual([]);
    } finally {
      restore();
    }
  });

  it('refuses an access-restricted listing instead of bypassing', async () => {
    const { adapter, restore } = buildAdapter({
      'https://www.crazygames.com/c/action': {
        body: Buffer.from('<html><body>Just a moment...</body></html>'),
      },
    });
    try {
      await expect(
        adapter.listGames('https://www.crazygames.com/c/action', {}),
      ).rejects.toThrow(/restricted access/i);
    } finally {
      restore();
    }
  });
});
