import { Injectable } from '@nestjs/common';
import {
  DetectionContext,
  DetectionResult,
  DetectionSignal,
  GameEngineImporter,
} from './types';

/**
 * CompositeDetector aggregates per-engine `detect()` results and picks the
 * highest-confidence engine above a threshold. Confidence comes from multiple
 * weighted signals — never a single filename/regex.
 */
@Injectable()
export class CompositeDetector {
  constructor(private readonly engines: GameEngineImporter[]) {}

  async detect(context: DetectionContext): Promise<DetectionResult> {
    const results = await Promise.all(
      this.engines.map((e) => e.detect(context)),
    );
    results.sort((a, b) => b.confidence - a.confidence);
    const best = results[0];
    if (!best || best.confidence < 0.5) {
      return {
        engine: 'unknown',
        confidence: best?.confidence ?? 0,
        signals: best?.signals ?? [],
      };
    }
    return best;
  }
}

/** Combine weighted signals into a 0..1 confidence score. */
export function scoreSignals(signals: DetectionSignal[]): number {
  let total = 0;
  let matched = 0;
  for (const s of signals) {
    total += s.weight;
    if (s.matched) matched += s.weight;
  }
  if (total <= 0) return 0;
  return Math.min(1, matched / total);
}
