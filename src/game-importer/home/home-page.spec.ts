import { renderHomePage } from './home-page';

describe('home page (folders)', () => {
  it('renders a complete standalone document', () => {
    const html = renderHomePage();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Game Folders — Home</title>');
    expect(html).toContain('id="foldersGrid"');
    expect(html).toContain('id="newFolderName"');
    expect(html).toContain('id="newFolderBtn"');
  });

  it('creates folders via the folders API', () => {
    const html = renderHomePage();
    expect(html).toContain('api("/folders"');
    expect(html).toContain('body: JSON.stringify({ name: name })');
  });

  it('opens a folder console by folder id from each card', () => {
    const html = renderHomePage();
    expect(html).toContain(
      '"/console/" + encodeURIComponent(card.getAttribute("data-id"))',
    );
  });

  it('copies the real packages path from between the icon and the name', () => {
    const html = renderHomePage();
    // Copy button sits inside the folder head, before the name.
    expect(html).toContain('class=\\"copy-btn\\"');
    expect(html).toContain('data-root=\\"" + esc(f.packagesRoot) + "\\"');
    expect(html).toContain('copyText(root, function () {');
    // Shows the copied state briefly.
    expect(html).toContain('btn.classList.add("copied")');
  });

  it('deletes folders with a confirmation, never deleting jobs', () => {
    const html = renderHomePage();
    expect(html).toContain('method: "DELETE"');
    expect(html).toContain('window.confirm');
    expect(html).toContain('Its games move to ungrouped');
  });

  it('links to the ungrouped console', () => {
    const html = renderHomePage();
    expect(html).toContain('href="/console/none"');
  });

  it('shows per-folder disk usage fetched with storage', () => {
    const html = renderHomePage();
    // Sizes come from the storage-enriched listing, rendered as a chip.
    expect(html).toContain('api("/folders?storage=true")');
    expect(html).toContain('chip size');
    expect(html).toContain('fmtBytes(f.storage.bytes)');
    expect(html).toContain('function fmtBytes(v)');
  });

  it('exports the library backup as a downloaded JSON file', () => {
    const html = renderHomePage();
    expect(html).toContain('id="exportBtn"');
    expect(html).toContain('Export backup (JSON)');
    expect(html).toContain('api("/folders/export")');
    expect(html).toContain('game-folders-backup-');
    expect(html).toContain('application/json');
  });

  it('imports a backup file back into folders', () => {
    const html = renderHomePage();
    expect(html).toContain('id="importBtn"');
    expect(html).toContain('Import backup');
    expect(html).toContain('id="importFile"');
    expect(html).toContain('api("/folders/import"');
    expect(html).toContain('That file is not valid JSON.');
    expect(html).toContain('already existed, skipped');
  });

  it('never executes game code or inlines untrusted URLs', () => {
    const html = renderHomePage();
    expect(html).not.toContain('eval(');
  });

  it('embeds syntactically valid JavaScript', () => {
    const html = renderHomePage();
    const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) {
      const code = b.replace(/^<script>/, '').replace(/<\/script>$/, '');
      expect(() => new Function(code)).not.toThrow();
    }
  });
});
