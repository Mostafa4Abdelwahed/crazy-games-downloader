import { Controller, Get, Header, Redirect } from '@nestjs/common';
import { renderConsolePage } from './console-page';

/**
 * Management console: a dependency-free status page over the existing
 * public import API. Displays job state, progress, diagnostics and logs,
 * and prints local run instructions for completed packages. Shows server-
 * side data only (package paths are local-fs locations, safe to display
 * to the operator); never executes imported game code.
 */
@Controller()
export class ConsoleController {
  @Get()
  @Redirect('/console', 302)
  root(): void {
    // Redirected to the console by the decorator; no body needed.
  }

  @Get('console')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  console(): string {
    return renderConsolePage();
  }
}
