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
