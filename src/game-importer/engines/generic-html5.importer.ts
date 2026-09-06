import { Injectable } from '@nestjs/common';
import { scoreSignals } from '../core/detector';
import {
  DetectionContext,
  DetectionResult,
  GameEngineImporter,
  GamePackage,
} from '../core/types';

/**
 * Generic HTML5 fallback engine (Milestone 1 placeholder).
 * Low-confidence detector; importer intentionally not implemented until
 * Milestone 2+ (per spec: do not implement every engine initially).
 */
@Injectable()
export class GenericHtml5Importer implements GameEngineImporter {
  name = 'generic-html5';

  async detect(context: DetectionContext): Promise<DetectionResult> {
    const html = (context.html ?? '').toLowerCase();
    const signals = [
      {
        name: 'has-html',
        weight: 1,
        matched: html.includes('<html') || html.includes('<!doctype html'),
      },
      {
        name: 'has-canvas-or-script',
        weight: 1,
        matched: html.includes('<canvas') || html.includes('<script'),
      },
    ];
    return {
      engine: 'generic-html5',
      confidence: scoreSignals(signals) * 0.4,
      signals,
    };
  }

  async import(): Promise<GamePackage> {
    throw new Error(
      'Generic HTML5 importer not implemented in Milestone 1 (Unity only)',
    );
  }
}
