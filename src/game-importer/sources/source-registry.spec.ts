import { SourceRegistry } from './source-registry';
import { GameSourceAdapter } from './source.interface';

function stub(name: string, handles: boolean): GameSourceAdapter {
  return {
    name,
    canHandle: () => handles,
    resolve: async () => {
      throw new Error('not implemented');
    },
  };
}

describe('SourceRegistry', () => {
  it('returns the first matching adapter', () => {
    const a = stub('a', false);
    const b = stub('crazygames', true);
    const registry = new SourceRegistry([a, b]);
    expect(registry.findAdapter('https://www.crazygames.com/game/x')).toBe(b);
    expect(registry.list()).toEqual(['a', 'crazygames']);
  });

  it('returns null when nothing matches (legacy path)', () => {
    const registry = new SourceRegistry([stub('a', false)]);
    expect(
      registry.findAdapter('https://partner.example/games/demo'),
    ).toBeNull();
  });

  it('skips adapters whose predicate throws', () => {
    const broken: GameSourceAdapter = {
      name: 'broken',
      canHandle: () => {
        throw new Error('boom');
      },
      resolve: async () => {
        throw new Error('not implemented');
      },
    };
    const good = stub('crazygames', true);
    const registry = new SourceRegistry([broken, good]);
    expect(registry.findAdapter('https://www.crazygames.com/game/x')).toBe(
      good,
    );
  });
});
