import * as fs from 'node:fs';
import * as path from 'node:path';
import { CrazyGamesParser, isCrazyGamesHost } from './crazygames.parser';

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, name), 'utf8');

describe('isCrazyGamesHost', () => {
  it('matches the platform and its subdomains only', () => {
    expect(isCrazyGamesHost('crazygames.com')).toBe(true);
    expect(isCrazyGamesHost('www.crazygames.com')).toBe(true);
    expect(isCrazyGamesHost('games.crazygames.com')).toBe(true);
    expect(isCrazyGamesHost('WWW.CrazyGames.COM')).toBe(true);
    expect(isCrazyGamesHost('evil-crazygames.com')).toBe(false);
    expect(isCrazyGamesHost('crazygames.com.evil.example')).toBe(false);
    expect(isCrazyGamesHost('fakecrazygames.com')).toBe(false);
    expect(isCrazyGamesHost('example.com')).toBe(false);
  });
});

describe('CrazyGamesParser URL normalization', () => {
  const parser = new CrazyGamesParser();

  it('lowercases host, strips fragments and trailing slashes', () => {
    expect(
      parser.normalizeUrl('https://WWW.CrazyGames.COM/game/space-adventure/'),
    ).toBe('https://www.crazygames.com/game/space-adventure');
    expect(
      parser.normalizeUrl('https://www.crazygames.com/game/x#comments'),
    ).toBe('https://www.crazygames.com/game/x');
  });

  it('preserves query strings (may carry auth/signature params)', () => {
    expect(
      parser.normalizeUrl('https://www.crazygames.com/game/x?sig=abc&v=2'),
    ).toBe('https://www.crazygames.com/game/x?sig=abc&v=2');
  });

  it('rejects malformed URLs and non-http protocols', () => {
    expect(() => parser.normalizeUrl('not a url')).toThrow();
    expect(() => parser.normalizeUrl('file:///etc/passwd')).toThrow();
    expect(() => parser.normalizeUrl('ftp://www.crazygames.com/x')).toThrow();
  });
});

describe('CrazyGamesParser page parsing', () => {
  const parser = new CrazyGamesParser();

  it('extracts metadata from og tags', () => {
    const meta = parser.extractMeta(read('unity-page.html'));
    expect(meta.title).toBe('Space Adventure');
    expect(meta.thumbnail).toBe(
      'https://images.crazygames.com/space-adventure/thumb.png',
    );
  });

  it('finds the game iframe and skips ad/social iframes', () => {
    const frame = parser.extractGameFrameUrl(
      read('unity-page.html'),
      'https://www.crazygames.com/game/space-adventure',
    );
    expect(frame).toBe(
      'https://games.crazygames.com/en_US/space-adventure/index.html',
    );
  });

  it('resolves relative iframe sources against the page URL', () => {
    const html = '<iframe src="/embed/game123"></iframe>';
    expect(
      parser.extractGameFrameUrl(html, 'https://www.crazygames.com/game/x'),
    ).toBe('https://www.crazygames.com/embed/game123');
  });

  it('returns null when no playable embed exists', () => {
    expect(
      parser.extractGameFrameUrl(
        read('unsupported-page.html'),
        'https://www.crazygames.com/top-10-space-games',
      ),
    ).toBeNull();
  });

  it('extracts absolute script/style asset URLs, excluding data: URLs', () => {
    const html = [
      '<script src="Build/g.loader.js"></script>',
      '<script src="data:text/javascript,alert(1)"></script>',
      '<link rel="stylesheet" href="css/style.css">',
      '<link rel="icon" href="favicon.ico">',
    ].join('\n');
    const assets = parser.extractAssetUrls(
      html,
      'https://games.crazygames.com/en_US/g/index.html',
    );
    expect(assets).toEqual([
      'https://games.crazygames.com/en_US/g/Build/g.loader.js',
      'https://games.crazygames.com/en_US/g/css/style.css',
    ]);
  });

  it('detects access-restriction pages that must not be bypassed', () => {
    expect(
      parser.detectAccessRestriction(
        '<html><body>Just a moment...</body></html>',
      ),
    ).toBe(true);
    expect(
      parser.detectAccessRestriction('<html><body>Access Denied</body></html>'),
    ).toBe(true);
    expect(parser.detectAccessRestriction(read('unity-page.html'))).toBe(false);
  });

  it('parses all five fixture layouts without throwing', () => {
    for (const name of [
      'unity-page.html',
      'html5-page.html',
      'unity-br-page.html',
      'unity-alt-page.html',
      'unsupported-page.html',
    ]) {
      const html = read(name);
      const discovery = parser.discoverFromPage(
        html,
        'https://www.crazygames.com/game/x',
      );
      expect(discovery.meta.title).toBeTruthy();
      if (name === 'unsupported-page.html') {
        expect(discovery.frameUrl).toBeNull();
      } else {
        expect(discovery.frameUrl).toContain('games.crazygames.com');
      }
    }
  });
});

describe('CrazyGamesParser game link extraction', () => {
  const parser = new CrazyGamesParser();
  const LISTING_BASE = 'https://www.crazygames.com/c/action';

  it('extracts canonical /game/{slug} links with title + thumbnail in page order', () => {
    const links = parser.extractGameLinks(
      read('listing-page.html'),
      LISTING_BASE,
    );
    expect(links).toEqual([
      {
        url: 'https://www.crazygames.com/game/space-adventure',
        title: 'Space Adventure',
        thumbnail: 'https://images.crazygames.com/space-adventure/thumb.png',
      },
      {
        url: 'https://www.crazygames.com/game/drive-quest---car-game',
        title: 'Drive Quest',
        thumbnail: 'https://images.crazygames.com/drive-quest/thumb.png',
      },
      {
        url: 'https://www.crazygames.com/game/neo-console',
        title: 'Neo Console',
        thumbnail: 'https://www.crazygames.com/assets/neo-console/thumb.jpg',
      },
      {
        url: 'https://www.crazygames.com/game/crystal-caves',
        title: 'Crystal Caves',
      },
    ]);
  });

  it('strips query + fragment so the same game maps to one canonical URL', () => {
    const html =
      '<a href="/game/foo?utm=x"><img src="/i/foo.png" alt="Foo"></a>' +
      '<a href="/game/foo#top"><img src="/i/foo2.png" alt="Foo Again"></a>';
    const links = parser.extractGameLinks(html, LISTING_BASE);
    expect(links).toEqual([
      {
        url: 'https://www.crazygames.com/game/foo',
        title: 'Foo',
        thumbnail: 'https://www.crazygames.com/i/foo.png',
      },
    ]);
  });

  it('falls back to the slug for title when a link has no text or alt', () => {
    const links = parser.extractGameLinks(
      '<a href="/game/neo-console"><img src="https://images.crazygames.com/nc/thumb.jpg"></a>',
      LISTING_BASE,
    );
    expect(links[0].title).toBe('neo console');
  });

  it('caps extraction at max (default 50, hard ceiling 200)', () => {
    const html = Array.from(
      { length: 60 },
      (_, i) => `<a href="/game/game-${i}"><span>Game ${i}</span></a>`,
    ).join('');
    expect(parser.extractGameLinks(html, LISTING_BASE)).toHaveLength(50);
    expect(parser.extractGameLinks(html, LISTING_BASE, 10)).toHaveLength(10);
  });

  it('accepts locale-prefixed /game/ links and canonicalizes them', () => {
    const links = parser.extractGameLinks(
      '<a href="/en/game/space-adventure"><span>Space Adventure</span></a>',
      LISTING_BASE,
    );
    expect(links[0].url).toBe(
      'https://www.crazygames.com/game/space-adventure',
    );
  });

  it('diagnoses why a listing yielded no game links', () => {
    const diag = parser.diagnoseListing(
      '<html><head><title>Consent Wall</title></head>' +
        '<body><a href="/about">About</a><a href="https://partner.example/x">X</a></body></html>',
      LISTING_BASE,
    );
    expect(diag.pageTitle).toBe('Consent Wall');
    expect(diag.totalAnchors).toBe(2);
    expect(diag.gameAnchors).toBe(0);
    expect(diag.hasNextData).toBe(false);
    expect(diag.accessRestricted).toBe(false);
  });
});

describe('CrazyGamesParser extractNextDataGames', () => {
  const parser = new CrazyGamesParser();
  const nextScript = (
    items: Array<{ name: string; slug: string; cover?: string }>,
  ) =>
    '<script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({
      props: {
        pageProps: {
          categoryState: {
            games: { pagination: { page: 1, size: 60 }, total: 500, items },
          },
        },
      },
      buildId: 'x',
    }) +
    '</script>';

  it('extracts the full paginated game grid from __NEXT_DATA__', () => {
    const links = parser.extractNextDataGames(
      nextScript([
        {
          name: 'War the Knights',
          slug: 'war-the-knights',
          cover: 'war-the-knights_16x9/c/wc-cover',
        },
        { name: 'Run 3', slug: 'run-3' },
      ]),
    );
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({
      url: 'https://www.crazygames.com/game/war-the-knights',
      title: 'War the Knights',
      thumbnail:
        'https://images.crazygames.com/war-the-knights_16x9/c/wc-cover?format=auto&quality=100&metadata=none&width=480&height=270',
    });
    expect(links[1]).toEqual({
      url: 'https://www.crazygames.com/game/run-3',
      title: 'Run 3',
    });
  });

  it('honors the max cap', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      name: `Game ${i}`,
      slug: `game-${i}`,
    }));
    expect(parser.extractNextDataGames(nextScript(items), 3)).toHaveLength(3);
  });

  it('returns [] for pages without a __NEXT_DATA__ blob or games list', () => {
    expect(parser.extractNextDataGames('<html><body>hi</body></html>')).toEqual(
      [],
    );
    expect(
      parser.extractNextDataGames(
        '<script id="__NEXT_DATA__">{"props":{"pageProps":{"nope":1}}}</script>',
      ),
    ).toEqual([]);
  });
});
