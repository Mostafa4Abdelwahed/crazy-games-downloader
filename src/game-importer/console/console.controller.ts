import { Controller, Get, Header, Param, Redirect } from '@nestjs/common';
import { renderConsolePage } from './console-page';
import { renderSettingsPage } from '../settings/settings-page';
import { renderHomePage } from '../home/home-page';

/**
 * Console routing:
 *  - `/`              home: folder list (create/open/delete folders)
 *  - `/console`       redirect to the ungrouped console (back-compat)
 *  - `/console/:id`   the console of one folder (id or "none")
 *  - `/console/settings` global settings page
 *
 * Pages are dependency-free HTML over the public API; server-side data
 * only, never executes imported game code.
 */
@Controller()
export class ConsoleController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  home(): string {
    return renderHomePage();
  }

  @Get('console')
  @Redirect('/console/none', 302)
  consoleRoot(): void {
    // Redirected by the decorator; legacy "/console" links keep working.
  }

  @Get('console/settings')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  settings(): string {
    return renderSettingsPage();
  }

  @Get('console/:folderId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  console(@Param('folderId') folderId: string): string {
    return renderConsolePage(folderId);
  }
}
