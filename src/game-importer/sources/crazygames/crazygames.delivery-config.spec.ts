import * as fs from 'node:fs';
import * as path from 'node:path';
import { SecureDownloader } from '../../core/downloader';
import {
  SourcePolicyService,
  SourceNotAllowedError,
} from '../../core/source-policy';
import { AuthorizedSourcePolicy } from '../authorized-source-policy';
import { CrazyGamesParser } from './crazygames.parser';
import { CrazyGamesSourceAdapter } from './crazygames.source';

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name: string): Buffer =>
  fs.readFileSync(path.join(FIXTURES, name));

interface FakeEntry {
  body: Buffer;
  finalUrl?: string;
}

function fakeDownloader(map: Record<string, FakeEntry>) {
  const calls: string[] = [];
  return {
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
}

const OLD_HOSTS = process.env.SOURCE_ALLOWED_HOSTS;
const OLD_ANY = process.env.ALLOW_ANY_HTTPS;

function buildAdapter(
  map: Record<string, FakeEntry>,
  allowedHosts = 'portal.crazygames.com,games.sub.crazygames.com,files.sub.crazygames.com',
) {
  process.env.SOURCE_ALLOWED_HOSTS = allowedHosts;
  process.env.ALLOW_ANY_HTTPS = 'false';
  const downloader = fakeDownloader(map);
  const adapter = new CrazyGamesSourceAdapter(
    new CrazyGamesParser(),
    downloader as unknown as SecureDownloader,
    new AuthorizedSourcePolicy(new SourcePolicyService()),
  );
  return { adapter, downloader };
}

afterEach(() => {
  if (OLD_HOSTS === undefined) delete process.env.SOURCE_ALLOWED_HOSTS;
  else process.env.SOURCE_ALLOWED_HOSTS = OLD_HOSTS;
  if (OLD_ANY === undefined) delete process.env.ALLOW_ANY_HTTPS;
  else process.env.ALLOW_ANY_HTTPS = OLD_ANY;
});

describe('CrazyGames delivery config (M3.1)', () => {
  it('extracts frame, loader, and build assets from portal delivery JSON', () => {
    const parser = new CrazyGamesParser();
    const html = read('portal-delivery-config.html').toString('utf8');
    const delivery = parser.extractDeliveryConfig(html);
    expect(delivery.frameUrls).toEqual([
      'https://games.sub.crazygames.com/en_US/fixture-racer/index.html',
      'https://games.sub.crazygames.com/mobile/fixture-racer/index.html',
    ]);
    expect(delivery.loaderUrl).toBe(
      'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.loader.js',
    );
    expect(delivery.configAssets).toEqual(
      expect.arrayContaining([
        'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.wasm.br',
        'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.data.br',
        'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.framework.js.br',
      ]),
    );
  });

  it('falls back to targeted key regexes without structured JSON', () => {
    const parser = new CrazyGamesParser();
    const delivery = parser.extractDeliveryConfig(
      '<html><body>{"desktopUrl":"https://games.sub.crazygames.com/g/x/index.html",' +
        '"unityLoaderUrl":"https://files.sub.crazygames.com/g/x/Build/x.loader.js",' +
        '"unityConfigOptions":{"codeUrl":"https://files.sub.crazygames.com/g/x/Build/x.wasm"}}' +
        '</body></html>',
    );
    expect(delivery.frameUrls).toEqual([
      'https://games.sub.crazygames.com/g/x/index.html',
    ]);
    expect(delivery.loaderUrl).toBe(
      'https://files.sub.crazygames.com/g/x/Build/x.loader.js',
    );
    expect(delivery.configAssets).toEqual([
      'https://files.sub.crazygames.com/g/x/Build/x.wasm',
    ]);
  });

  it('ignores non-http delivery values', () => {
    const parser = new CrazyGamesParser();
    const delivery = parser.extractDeliveryConfig(
      '<html><body>{"desktopUrl":"file:///etc/passwd",' +
        '"unityLoaderUrl":"javascript:alert(1)",' +
        '"unityConfigOptions":{"codeUrl":"ftp://files.sub.crazygames.com/x.wasm"}}' +
        '</body></html>',
    );
    expect(delivery.frameUrls).toEqual([]);
    expect(delivery.loaderUrl).toBeUndefined();
    expect(delivery.configAssets).toEqual([]);
  });

  it('resolves delivery frame + assets through the adapter', async () => {
    const pageUrl = 'https://portal.crazygames.com/game/fixture-racer';
    const frameUrl =
      'https://games.sub.crazygames.com/en_US/fixture-racer/index.html';
    const { adapter } = buildAdapter({
      [pageUrl]: { body: read('portal-delivery-config.html') },
      [frameUrl]: {
        body: Buffer.from(
          '<html><body><canvas></canvas><script src="Build/fp.loader.js"></script></body></html>',
        ),
      },
    });
    const resolved = await adapter.resolve(pageUrl, {});
    expect(resolved.gameUrl).toBe(frameUrl);
    expect(resolved.entryUrl).toBe(frameUrl);
    // Loader bundle + all three Brotli build assets are exposed as hints.
    expect(resolved.assetUrls).toEqual(
      expect.arrayContaining([
        'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.loader.js',
        'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.wasm.br',
        'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.data.br',
        'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.framework.js.br',
      ]),
    );
    expect(resolved.metadata?.title).toBe('Fixture Portal Racer');
  });

  it('fails closed when the delivery frame host is not allowlisted', async () => {
    const pageUrl = 'https://portal.crazygames.com/game/fixture-racer';
    // games.sub.crazygames.com deliberately missing from the allowlist, so
    // the post-fetch policy re-check on the frame URL must refuse it.
    const { adapter } = buildAdapter(
      {
        [pageUrl]: { body: read('portal-delivery-config.html') },
        'https://games.sub.crazygames.com/en_US/fixture-racer/index.html': {
          body: Buffer.from('<html><body>game</body></html>'),
        },
      },
      'portal.crazygames.com,files.sub.crazygames.com',
    );
    await expect(adapter.resolve(pageUrl, {})).rejects.toBeInstanceOf(
      SourceNotAllowedError,
    );
  });
});
