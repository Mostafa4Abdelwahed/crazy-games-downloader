import { renderConsolePage } from './console-page';

describe('management console page', () => {
  it('renders a complete standalone document', () => {
    const html = renderConsolePage();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('id="sourceUrls"');
    expect(html).toContain('id="startForm"');
    expect(html).toContain('id="startBtn"');
    expect(html).toContain('id="jobRows"');
    expect(html).toContain('id="detail"');
  });

  it('supports multi-game import and re-import of past runs', () => {
    const html = renderConsolePage();
    expect(html).toContain('/game-imports/batch');
    // reimportBtn id lives inside the page script, where HTML attributes
    // are escaped (\"reimportBtn\"), so match the bare id.
    expect(html).toContain('reimportBtn');
    expect(html).toContain('Start imports');
    expect(html).toContain('One game URL per line');
    // Single create endpoint stays available for the re-import button.
    expect(html).toContain('"/game-imports"');
    // Re-import forces a fresh run past the global dedup; per-job delete
    // asks for confirmation then calls DELETE on the job.
    expect(html).toContain('force: true');
    expect(html).toContain('deleteJobBtn');
    expect(html).toContain('window.confirm');
    expect(html).toContain('method: "DELETE"');
  });

  it('drives only the existing public import API', () => {
    const html = renderConsolePage();
    expect(html).toContain('/game-imports');
    expect(html).toContain('python -m http.server 8080');
    expect(html).toContain('http://localhost:8080');
    expect(html).toContain('file://');
    // Must never execute imported game code or inline untrusted URLs.
    expect(html).not.toContain('eval(');
  });

  it('embeds syntactically valid JavaScript', () => {
    const html = renderConsolePage();
    // Head theme bootstrap + main console script must both parse.
    const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) {
      const code = b.replace(/^<script>/, '').replace(/<\/script>$/, '');
      expect(() => new Function(code)).not.toThrow();
    }
  });

  it('replaces emoji glyphs with inline SVG icons', () => {
    const html = renderConsolePage();
    // No emoji or arrow-symbol glyphs anywhere in the page markup.
    expect(html).not.toMatch(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/u,
    );
    // Icons are inline SVG (logo gamepad + re-import refresh).
    expect(html).toContain('<svg viewBox="0 0 24 24"');
    expect(html).toContain('.logo svg');
    expect(html).toContain('.btn svg');
    expect(html).toContain('Re-import</button>');
  });

  it('discovers games from a listing page into a checkbox modal', () => {
    const html = renderConsolePage();
    // Discover input + button that POSTs to the discover endpoint.
    expect(html).toContain('id="discoverUrl"');
    expect(html).toContain('id="discoverBtn"');
    expect(html).toContain('/game-imports/discover');
    expect(html).toContain('pageUrl: url');
    // Modal dialog with per-game rows (thumbnail, title, URL, Added badge).
    expect(html).toContain('id="discoverModal"');
    expect(html).toContain('id="discoverList"');
    expect(html).toContain('id="discoverCloseBtn"');
    expect(html).toContain('id="discoverCount"');
    expect(html).toContain('id="discoverAddBtn"');
    expect(html).toContain('id="discoverSelectAllBtn"');
    expect(html).toContain('id="discoverClearBtn"');
    expect(html).toContain('Select all');
    expect(html).toContain('Add selected');
    expect(html).toContain('.grow{');
    expect(html).toContain('.grow img.thumb{');
    expect(html).toContain('data-key');
    expect(html).toContain('g.already');
    expect(html).toContain('g.thumbnail');
    // Modal + row styles live in the page stylesheet.
    expect(html).toContain('.modal-panel{');
    expect(html).toContain('.modal-foot{');
    expect(html).toContain('.badge{');
    // Batch adds happen in chunks of 25 (the batch DTO cap).
    expect(html).toContain('slice(i, i + 25)');
    // Server-side diagnostic note is shown instead of a blind error.
    expect(html).toContain('r.note || "No games found on that page."');
  });

  it('paginates the jobs table with Prev/Next and a page-size picker', () => {
    const html = renderConsolePage();
    // Pager controls under the jobs table.
    expect(html).toContain('id="jobsPrevBtn"');
    expect(html).toContain('id="jobsNextBtn"');
    expect(html).toContain('id="jobsPageInfo"');
    expect(html).toContain('id="jobsPageSize"');
    // Reads the paginated { items, total, totalPages } response,
    // scoped to the console's folder.
    expect(html).toContain('jobsQuery()');
    expect(html).toContain('"&folderId=" + encodeURIComponent(FOLDER_ID)');
    expect(html).toContain('data.items');
    expect(html).toContain('data.totalPages');
    // Prev disabled on page 1, Next disabled past the last page.
    expect(html).toContain('prev.disabled = jobPage <= 1');
    expect(html).toContain('next.disabled = jobPage >= jobTotalPages');
    // New imports jump back to page 1 so the newest job is visible.
    expect(html).toContain('jobPage = 1');
    // Pager buttons with nowhere to go read as disabled, not as "loading"
    // (no wait cursor on the global .btn:disabled rule).
    expect(html).toContain('.pager .btn:disabled{cursor:not-allowed}');
    // Discover button matches the primary "Start imports" style.
    expect(html).toContain('id="discoverBtn" class="btn primary"');
  });

  it('fetches job details on click via get-one, not from the listing', () => {
    const html = renderConsolePage();
    // The table renders only row fields; heavy detail comes from a dedicated
    // per-job request (plus logs) when a row is selected.
    expect(html).toContain('jobsQuery()');
    expect(html).toContain('j.sourceUrl');
    expect(html).toContain('j.progress');
    expect(html).toContain('j.updatedAt');
    expect(html).toContain('"/game-imports/" + encodeURIComponent(selectedId)');
    expect(html).toContain(
      '"/game-imports/" + encodeURIComponent(selectedId) + "/logs"',
    );
  });

  it('uses a two-column workbench: scrollable jobs left, sticky details right', () => {
    const html = renderConsolePage();
    // Jobs + Details live side by side; Details sticks while jobs scroll.
    expect(html).toContain('class="workbench"');
    expect(html).toContain('workbench-left');
    expect(html).toContain('workbench-right');
    expect(html).toContain('.workbench-right{position:sticky');
    expect(html).toContain(
      'grid-template-columns:minmax(0,1.7fr) minmax(320px,1fr)',
    );
    // The sticky panel scrolls its own content instead of the page.
    expect(html).toContain('.workbench-right #detail{overflow-y:auto');
    // Narrow viewports fall back to a single stacked column.
    expect(html).toContain('@media (max-width:980px)');
  });

  it('is scoped to one folder: new imports land in that folder', () => {
    const html = renderConsolePage('f-123');
    // The folder id is embedded and used for every scoped call.
    expect(html).toContain('var FOLDER_ID = "f-123"');
    expect(html).toContain(
      'JSON.stringify({ sourceUrls: urls, folderId: FOLDER_ID })',
    );
    expect(html).toContain(
      'JSON.stringify({ sourceUrls: chunk, folderId: FOLDER_ID })',
    );
    // The title resolves the folder name from the folders API.
    expect(html).toContain('api("/folders/" + encodeURIComponent(FOLDER_ID))');
    // Home (folders) is reachable from the nav.
    expect(html).toContain('href="/"');
  });

  it('defaults to the ungrouped collection when no folder is given', () => {
    const html = renderConsolePage();
    expect(html).toContain('var FOLDER_ID = "none"');
  });

  it('shows sequential job numbers instead of raw UUIDs', () => {
    const html = renderConsolePage();
    // The table header switched from "ID" to "#"; rows render #seq.
    expect(html).toContain('<th>#</th>');
    expect(html).toContain(
      '"<td><code>#" + (j.seq != null ? esc(j.seq) : "?") + "</code></td>"',
    );
  });

  it('filters and sorts the jobs table from the UI', () => {
    const html = renderConsolePage();
    // Status filter dropdown with every ImportState.
    expect(html).toContain('id="filterStatus"');
    for (const s of [
      'queued',
      'downloading',
      'validating',
      'completed',
      'failed',
      'cancelled',
    ]) {
      expect(html).toContain(`<option value="${s}">`);
    }
    // Sort dropdown + direction toggle, all wired into the query.
    expect(html).toContain('id="sortKey"');
    expect(html).toContain('id="sortDir"');
    expect(html).toContain(
      '"&sort=" + encodeURIComponent(jobSortKey) + "&dir=" + jobSortDir',
    );
    expect(html).toContain(
      'if (jobStatusFilter) q += "&status=" + encodeURIComponent(jobStatusFilter)',
    );
    // Changing a filter/sort resets back to page 1.
    expect(html.split('jobPage = 1;').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('searches jobs by game URL with a debounced input', () => {
    const html = renderConsolePage();
    // Search box sits in the filters row and searches the source URL.
    expect(html).toContain('id="searchQ"');
    expect(html).toContain('Search by game URL');
    expect(html).toContain(
      'if (jobSearchQ) q += "&q=" + encodeURIComponent(jobSearchQ)',
    );
    // Debounced so it does not fire a request on every keystroke.
    expect(html).toContain('setTimeout(function () {');
    expect(html).toContain('}, 300)');
    expect(html).toContain('clearTimeout(searchTimer)');
  });

  it('retries every failed game in the folder from the filters row', () => {
    const html = renderConsolePage();
    expect(html).toContain('id="retryFailedBtn"');
    expect(html).toContain('Retry failed');
    expect(html).toContain('"/game-imports/retry-failed"');
    expect(html).toContain('body: JSON.stringify({ folderId: FOLDER_ID })');
    // Reports how many were retried (or that there was nothing to do).
    expect(html).toContain('Retried " + r.retried + " failed game');
    expect(html).toContain('No failed games to retry in this folder.');
  });

  it('selects rows for bulk delete and bulk retry', () => {
    const html = renderConsolePage();
    // Checkbox column in the header and on every row.
    expect(html).toContain('id="selAll"');
    expect(html).toContain('class=\\"rowSel\\"');
    // Bulk bar with both actions, hidden until something is selected.
    expect(html).toContain('id="bulkBar"');
    expect(html).toContain('id="bulkDeleteBtn"');
    expect(html).toContain('id="bulkRetryBtn"');
    expect(html).toContain('id="bulkClearBtn"');
    // Row clicks still open details; checkbox clicks do not.
    expect(html).toContain('classList.contains("rowSel")');
    // Bulk delete confirms, then DELETEs one by one.
    expect(html).toContain('window.confirm("Delete "');
    expect(html).toContain('method: "DELETE"');
    // Bulk retry forces fresh runs, preserving each job folder.
    expect(html).toContain('force: true');
    expect(html).toContain('Retried " + done + " job(s) as fresh runs.');
  });

  it('polls the job list only while jobs are in flight, never when idle', () => {
    const html = renderConsolePage();
    // The only loadJobs interval anywhere is the one inside startPoll(),
    // which runs only when a fetched page contains an in-flight status.
    const loadJobsIntervals =
      html.split('setInterval(loadJobs, 5000)').length - 1;
    expect(loadJobsIntervals).toBe(1);
    expect(html).toContain('pollTimer = setInterval(loadJobs, 5000)');
    expect(html).toContain('function startPoll()');
    expect(html).toContain('function stopPoll()');
    expect(html).toContain('IN_FLIGHT.indexOf(j.status) >= 0');
    // stopPoll clears the timer; startPoll guards against double timers.
    expect(html).toContain('clearInterval(pollTimer)');
    expect(html).toContain('if (pollTimer) return;');
  });

  it('is styled with the CrazyGames-inspired design system', () => {
    const html = renderConsolePage();
    // Design tokens from the game-portal theme.
    expect(html).toContain('--canvas:#14151f');
    expect(html).toContain('--brand:#6842ff');
    expect(html).toContain('--primary:#28293d');
    expect(html).toContain('--radius-pill:30px');
    expect(html).toContain('--radius-card:20px');
    expect(html).toContain('--text:#ffffff');
    // Layout primitives.
    expect(html).toContain('class="appbar"');
    expect(html).toContain('class="card"');
    expect(html).toContain('.btn{');
    // Button variants from the system: variant 2 (#6842ff), variant 1
    // (rgba white tint), variant 3 (light #f9faff).
    expect(html).toContain('btn primary');
    expect(html).toContain('btn ghost');
    expect(html).toContain('btn light');
    expect(html).toContain('.btn.dark');
    // Rounded playful typography + flat-colour canvas with ambient glow.
    expect(html).toContain('Nunito');
    expect(html).toContain('radial-gradient');
    expect(html).toContain('color-scheme:dark');
    // Box-model: global border-box so width:100% inputs stay inside cards.
    expect(html).toContain('box-sizing:border-box');
    // Run-locally block has a top-right copy icon with clipboard wiring.
    expect(html).toContain('.runbox{');
    expect(html).toContain('copyRunBtn');
    expect(html).toContain('runCmd');
    expect(html).toContain('navigator.clipboard');
    // Copy feedback: icon swaps to a checkmark when copied.
    expect(html).toContain('CHECK_ICON');
    expect(html).toContain('M20 6L9 17l-5-5');
    // One-click "try this game": Start serves the local package and opens
    // the browser; Stop tears the loopback server back down. No manual
    // cd + python needed per game.
    expect(html).toContain('runBtn');
    expect(html).toContain('stopBtn');
    expect(html).toContain('runStatus');
    expect(html).toContain('function runGame(jobId)');
    expect(html).toContain('function stopGame(jobId)');
    expect(html).toContain(
      '"/game-imports/" + encodeURIComponent(jobId) + "/run"',
    );
    expect(html).toContain(
      '"/game-imports/" + encodeURIComponent(jobId) + "/stop"',
    );
    expect(html).toContain('runGame(selectedId)');
    expect(html).toContain('stopGame(selectedId)');
    expect(html).toContain('disabled');
    expect(html).toContain('Running at ');
    // Appbar is a glass (blurred translucent) bar with a brand edge.
    expect(html).toContain('backdrop-filter:blur(14px) saturate(150%)');
    expect(html).toContain('rgba(104,66,255,.25)');
    // Light & dark mode: tokenized themes + persisted manual toggle.
    expect(html).toContain(':root[data-theme="light"]');
    expect(html).toContain('color-scheme:light');
    expect(html).toContain('id="themeBtn"');
    expect(html).toContain('prefers-color-scheme: light');
    expect(html).toContain('SUN_ICON');
    expect(html).toContain('localStorage.setItem("cg2-theme"');
    // Inline SVG favicon matching the brand logo tile.
    expect(html).toContain('rel="icon"');
    expect(html).toContain('data:image/svg+xml');
    expect(html).toContain('%236842ff');
    // Light mode uses soft, low-alpha shadows (dark keeps its own tokens).
    expect(html).toContain('--shadow-1:rgba(31,34,60,.06)');
    expect(html).toContain(
      '--glass-shadow:0 10px 30px -22px rgba(31,34,60,.35)',
    );
  });
});
