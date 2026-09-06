import { CompositeDetector, scoreSignals } from './detector';

describe('confidence scoring', () => {
  it('weights matched signals', () => {
    expect(
      scoreSignals([
        { name: 'a', weight: 3, matched: true },
        { name: 'b', weight: 1, matched: false },
      ]),
    ).toBeCloseTo(0.75);
    expect(scoreSignals([])).toBe(0);
  });

  it('composite picks highest-confidence engine above threshold', async () => {
    const composite = new CompositeDetector([
      {
        name: 'unity',
        detect: async () => ({
          engine: 'unity',
          confidence: 0.9,
          signals: [],
        }),
        import: async () => {
          throw new Error('x');
        },
      },
      {
        name: 'generic-html5',
        detect: async () => ({
          engine: 'generic-html5',
          confidence: 0.3,
          signals: [],
        }),
        import: async () => {
          throw new Error('x');
        },
      },
    ]);
    const res = await composite.detect({ sourceUrl: 'https://x.example' });
    expect(res.engine).toBe('unity');
  });

  it('returns unknown below threshold', async () => {
    const composite = new CompositeDetector([
      {
        name: 'unity',
        detect: async () => ({
          engine: 'unity',
          confidence: 0.2,
          signals: [],
        }),
        import: async () => {
          throw new Error('x');
        },
      },
    ]);
    const res = await composite.detect({ sourceUrl: 'https://x.example' });
    expect(res.engine).toBe('unknown');
  });
});
