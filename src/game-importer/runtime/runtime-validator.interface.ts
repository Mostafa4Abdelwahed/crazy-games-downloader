import {
  RuntimeValidationOptions,
  RuntimeValidationResult,
} from './runtime.types';
import { GamePackage } from '../core/types';

/**
 * Runtime validation contract (M3). Implementations serve the generated
 * package over local HTTP and drive it in a real browser. Imported games
 * are untrusted third-party code: they run ONLY inside the browser
 * sandbox — never in Node.js, never via eval.
 */
export interface RuntimeValidator {
  readonly name: string;
  validate(
    pkg: GamePackage,
    options?: RuntimeValidationOptions,
  ): Promise<RuntimeValidationResult>;
}
