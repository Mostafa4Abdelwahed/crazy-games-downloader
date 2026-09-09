import { renderSettingsPage } from './settings-page';

describe('settings page', () => {
  it('renders a complete standalone document', () => {
    const html = renderSettingsPage();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Settings — Game Import Console</title>');
    expect(html).toContain('id="stats"');
    expect(html).toContain('id="confirmModal"');
    expect(html).toContain('id="confirmInput"');
    expect(html).toContain('id="confirmYesBtn"');
  });

  it('shows every settings section', () => {
    const html = renderSettingsPage();
    expect(html).toContain('id="kvServer"');
    expect(html).toContain('id="kvDatabase"');
    expect(html).toContain('id="kvQueue"');
    expect(html).toContain('id="kvLimits"');
    expect(html).toContain('id="kvPaths"');
    expect(html).toContain('id="kvSecurity"');
    expect(html).toContain('id="kvRuntime"');
  });

  it('renders the danger zone with all four destructive actions', () => {
    const html = renderSettingsPage();
    expect(html).toContain('Danger zone');
    expect(html).toContain('id="clearJobsBtn"');
    expect(html).toContain('id="clearWorkBtn"');
    expect(html).toContain('id="clearPackagesBtn"');
    expect(html).toContain('id="resetAllBtn"');
  });

  it('guards destructive actions behind the DELETE confirmation phrase', () => {
    const html = renderSettingsPage();
    expect(html).toContain('Type DELETE to confirm');
    expect(html).toContain('toUpperCase() !== "DELETE"');
    // Server endpoints are wired for re-checked confirmation.
    expect(html).toContain('/game-imports/settings/clear-jobs');
    expect(html).toContain('/game-imports/settings/clear-work');
    expect(html).toContain('/game-imports/settings/clear-packages');
    expect(html).toContain('/game-imports/settings/reset-all');
    expect(html).toContain('JSON.stringify({ confirm: phrase })');
  });

  it('links back to the console and marks itself active', () => {
    const html = renderSettingsPage();
    expect(html).toContain('href="/console"');
    expect(html).toContain('href="/console/settings"');
    expect(html).toContain('class="active"');
  });

  it('shows on-disk usage next to the package and work counts', () => {
    const html = renderSettingsPage();
    expect(html).toContain('fmtBytes(s.stats.packagesBytes || 0)');
    expect(html).toContain('fmtBytes(s.stats.workBytes || 0)');
  });

  it('never executes game code or inlines untrusted URLs', () => {
    const html = renderSettingsPage();
    expect(html).not.toContain('eval(');
  });

  it('embeds syntactically valid JavaScript', () => {
    const html = renderSettingsPage();
    const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) {
      const code = b.replace(/^<script>/, '').replace(/<\/script>$/, '');
      expect(() => new Function(code)).not.toThrow();
    }
  });
});
