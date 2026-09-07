import * as fs from 'node:fs';
import * as path from 'node:path';
import { SecureDownloader } from '../../core/downloader';
import { SourcePolicyService } from '../../core/source-policy';
import { AuthorizedSourcePolicy } from '../authorized-source-policy';
import { CrazyGamesParser } from './crazygames.parser';
import { CrazyGamesSourceAdapter } from './crazygames.source';

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name: string): Buffer =>
  fs.readFileSync(path.join(FIXTURES, name));

function fakeDownloader(map: Record<string, Buffer>) {
  return {
    fetchBuffer: async (url: string) => {
      const body = map[url];
      if (!body) throw new Error(`Fake 404 for ${url}`);
      return {
        finalUrl: url,
        status: 200,
        contentType: 'text/html',
        body,
        redirected: false,
      };
    },
  };
}

const OLD_HOSTS = process.env.SOURCE_ALLOWED_HOSTS;
const OLD_ANY = process.env.ALLOW_ANY_HTTPS;

afterEach(() => {
  if (OLD_HOSTS === undefined) delete process.env.SOURCE_ALLOWED_HOSTS;
  else process.env.SOURCE_ALLOWED_HOSTS = OLD_HOSTS;
  if (OLD_ANY === undefined) delete process.env.ALLOW_ANY_HTTPS;
  else process.env.ALLOW_ANY_HTTPS = OLD_ANY;
});

describe('CrazyGames role-labeled Unity build URLs', () => {
  it('extracts keyed build roles from portal delivery JSON', () => {
    const parser = new CrazyGamesParser();
    const delivery = parser.extractDeliveryConfig(
      read('portal-delivery-config.html').toString('utf8'),
    );
    expect(delivery.buildRoles['codeUrl']).toBe(
      'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.wasm.br',
    );
    expect(delivery.buildRoles['dataUrl']).toBe(
      'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.data.br',
    );
    expect(delivery.buildRoles['frameworkUrl']).toBe(
      'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.framework.js.br',
    );
    expect(delivery.buildRoles['streamingAssetsUrl']).toBe(
      'https://files.sub.crazygames.com/fixture-racer/77/StreamingAssets',
    );
    // Flat hints keep working as before.
    expect(delivery.configAssets).toEqual(
      expect.arrayContaining([delivery.buildRoles['codeUrl'] as string]),
    );
  });

  it('keeps scheme-less relative role values raw, out of flat hints', () => {
    const parser = new CrazyGamesParser();
    const delivery = parser.extractDeliveryConfig(
      '<html><body>{"desktopUrl":"https://games.sub.crazygames.com/g/x/index.html",' +
        '"unityLoaderUrl":"https://files.sub.crazygames.com/g/x/Build/962b.js",' +
        '"unityConfigOptions":{"codeUrl":"https://files.sub.crazygames.com/g/x/Build/2d.wasm.br",' +
        '"dataUrl":"https://files.sub.crazygames.com/g/x/Build/ef.data.br",' +
        '"frameworkUrl":"https://files.sub.crazygames.com/g/x/Build/ba.js.br",' +
        '"streamingAssetsUrl":"StreamingAssets"}}' +
        '</body></html>',
    );
    expect(delivery.buildRoles['streamingAssetsUrl']).toBe('StreamingAssets');
    expect(delivery.configAssets).not.toContain('StreamingAssets');
  });

  it('refuses non-http role values', () => {
    const parser = new CrazyGamesParser();
    const delivery = parser.extractDeliveryConfig(
      '<html><body>{"desktopUrl":"https://games.sub.crazygames.com/g/x/index.html",' +
        '"unityLoaderUrl":"https://files.sub.crazygames.com/g/x/Build/962b.js",' +
        '"unityConfigOptions":{"codeUrl":"ftp://files.sub.crazygames.com/x.wasm",' +
        '"dataUrl":"javascript:alert(1)"}}' +
        '</body></html>',
    );
    expect(delivery.buildRoles['codeUrl']).toBeUndefined();
    expect(delivery.buildRoles['dataUrl']).toBeUndefined();
  });

  it('maps delivery roles onto the generic resolved source', async () => {
    process.env.SOURCE_ALLOWED_HOSTS =
      'portal.crazygames.com,games.sub.crazygames.com,files.sub.crazygames.com';
    process.env.ALLOW_ANY_HTTPS = 'false';
    const pageUrl = 'https://portal.crazygames.com/game/fixture-racer';
    const frameUrl =
      'https://games.sub.crazygames.com/en_US/fixture-racer/index.html';
    const adapter = new CrazyGamesSourceAdapter(
      new CrazyGamesParser(),
      fakeDownloader({
        [pageUrl]: read('portal-delivery-config.html'),
        [frameUrl]: Buffer.from(
          '<html><body><canvas></canvas><script src="Build/fp.loader.js"></script></body></html>',
        ),
      }) as unknown as SecureDownloader,
      new AuthorizedSourcePolicy(new SourcePolicyService()),
    );
    const resolved = await adapter.resolve(pageUrl, {});
    expect(resolved.unityBuild?.loaderUrl).toBe(
      'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.loader.js',
    );
    expect(resolved.unityBuild?.dataUrl).toBe(
      'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.data.br',
    );
    expect(resolved.unityBuild?.frameworkUrl).toBe(
      'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.framework.js.br',
    );
    expect(resolved.unityBuild?.codeUrl).toBe(
      'https://files.sub.crazygames.com/fixture-racer/77/Build/fp.wasm.br',
    );
    expect(resolved.unityBuild?.streamingAssetsUrl).toBe(
      'https://files.sub.crazygames.com/fixture-racer/77/StreamingAssets',
    );
  });

  it('omits roles when the page exposes no labeled build', async () => {
    process.env.SOURCE_ALLOWED_HOSTS =
      'portal.crazygames.com,games.sub.crazygames.com';
    process.env.ALLOW_ANY_HTTPS = 'false';
    const pageUrl = 'https://portal.crazygames.com/game/plain';
    const frameUrl = 'https://games.sub.crazygames.com/en_US/plain/index.html';
    const adapter = new CrazyGamesSourceAdapter(
      new CrazyGamesParser(),
      fakeDownloader({
        [pageUrl]: Buffer.from(
          '<html><head><title>t</title></head><body><iframe src="' +
            frameUrl +
            '"></iframe></body></html>',
        ),
        [frameUrl]: Buffer.from('<html><body>game</body></html>'),
      }) as unknown as SecureDownloader,
      new AuthorizedSourcePolicy(new SourcePolicyService()),
    );
    const resolved = await adapter.resolve(pageUrl, {});
    expect(resolved.unityBuild).toBeUndefined();
  });
});
