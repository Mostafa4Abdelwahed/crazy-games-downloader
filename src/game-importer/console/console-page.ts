/**
 * Management console page (M3.2 DX).
 *
 * A single dependency-free HTML document served at `GET /console`, styled
 * with a design system inspired by free online game portals (CrazyGames):
 * dark canvas, deep-navy surfaces, purple brand accents (#6842ff), flat
 * color contrast, pill-radius action buttons, and playful rounded
 * typography. The rounded typeface is fetched from Google Fonts but
 * degrades gracefully to system fonts when offline.
 *
 * It calls only the existing public import API (`POST /game-imports`,
 * `POST /game-imports/batch`, `POST /game-imports/discover`,
 * `GET /game-imports`, `GET /game-imports/:id`, `POST …/cancel`, `GET …/logs`)
 * from same-origin browser JavaScript. Pure
 * string renderer so the markup is unit-testable; no game code is ever
 * executed here (imported games run only in the isolated Playwright sandbox
 * / operator-served packages).
 */
/**
 * Renders the import console for ONE folder. `folderId` is the URL path
 * segment: a real folder id or "none" for the ungrouped collection. The
 * page resolves the folder name client-side and scopes every jobs call.
 */
export function renderConsolePage(folderId: string = 'none'): string {
  return (
    '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="dark light">\n' +
    '<title>Game Import Console</title>\n' +
    '<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Crect%20width=%2724%27%20height=%2724%27%20rx=%2712%27%20fill=%27%236842ff%27/%3E%3Cpath%20d=%27M17.32%205H6.68a4%204%200%200%200-3.98%203.59c-.007.052-.01.101-.017.152C2.6%209.42%202%2014.46%202%2016a3%203%200%200%200%203%203c1%200%201.5-.5%202-1l1.41-1.41A2%202%200%200%201%209.83%2016h4.34a2%202%200%200%201%201.41.59L17%2018c.5.5%201%201%202%201a3%203%200%200%200%203-3c0-1.54-.6-6.58-.68-7.26-.01-.05-.01-.1-.02-.15A4%204%200%200%200%2017.32%205z%27%20stroke=%27%23fff%27%20stroke-width=%271.6%27%20fill=%27none%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27/%3E%3Cline%20x1=%276%27%20x2=%2710%27%20y1=%2711%27%20y2=%2711%27%20stroke=%27%23fff%27%20stroke-width=%271.6%27%20stroke-linecap=%27round%27/%3E%3Cline%20x1=%278%27%20x2=%278%27%20y1=%279%27%20y2=%2713%27%20stroke=%27%23fff%27%20stroke-width=%271.6%27%20stroke-linecap=%27round%27/%3E%3Ccircle%20cx=%2715%27%20cy=%2712%27%20r=%270.6%27%20fill=%27%23fff%27/%3E%3Ccircle%20cx=%2718%27%20cy=%279.5%27%20r=%270.6%27%20fill=%27%23fff%27/%3E%3Ccircle%20cx=%2718%27%20cy=%2714.5%27%20r=%270.6%27%20fill=%27%23fff%27/%3E%3C/svg%3E">\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;800&display=swap" rel="stylesheet">\n' +
    '<script>\n' +
    '(function(){try{var t=localStorage.getItem("cg2-theme");if(t!=="light"&&t!=="dark")t=(window.matchMedia("(prefers-color-scheme: light)").matches)?"light":"dark";document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();\n' +
    '</script>\n' +
    '<style>\n' +
    ':root{\n' +
    '  color-scheme:dark;\n' +
    '  --canvas:#14151f;\n' +
    '  --surface:#1e2033;\n' +
    '  --surface-raised:#262a42;\n' +
    '  --surface-tint:rgba(255,255,255,0.07);\n' +
    '  --primary:#28293d;\n' +
    '  --primary-hover:#353858;\n' +
    '  --brand:#6842ff;\n' +
    '  --brand-hover:#7a5aff;\n' +
    '  --brand-soft:#a48eff;\n' +
    '  --on-brand:#f9faff;\n' +
    '  --text:#ffffff;\n' +
    '  --text-2:#e5e6ee;\n' +
    '  --text-3:#989db3;\n' +
    '  --divider:rgba(255,255,255,0.10);\n' +
    '  --error:#ff5f6d;\n' +
    '  --ok:#6ee7a0;\n' +
    '  --warn:#ffc24b;\n' +
    '  --radius-pill:30px;\n' +
    '  --radius-card:20px;\n' +
    '  --radius-med:16px;\n' +
    '  --radius-sm:8px;\n' +
    '    --shadow-1:rgba(0,0,0,.2) 0px 3px 3px -2px,rgba(0,0,0,.14) 0px 3px 4px 0px,rgba(0,0,0,.12) 0px 1px 8px 0px;\n' +
    '  --shadow-2:rgba(0,0,0,.9) 0px 14px 40px 0px;\n' +
    '  --glow:rgba(104,66,255,.16);\n' +
    '  --glass-bg:rgba(23,25,39,.55);\n' +
    '  --glass-edge:rgba(104,66,255,.25);\n' +
    '  --glass-hi:rgba(255,255,255,.04);\n' +
    '  --sel-bg:rgba(104,66,255,.16);\n' +
    '  --ghost-bg:rgba(255,255,255,.10);\n' +
    '  --ghost-fg:#eff0f7;\n' +
    '  --ghost-hover:rgba(255,255,255,.16);\n' +
    '  --bar-track:rgba(255,255,255,.10);\n' +
    '  --glass-shadow:0 14px 34px -20px rgba(0,0,0,.65);\n' +
    '  --queued-bg:rgba(104,66,255,.18);--queued-fg:#cbbdff;--queued-bd:rgba(104,66,255,.4);\n' +
    '  --ok-bg:rgba(110,231,160,.14);--ok-fg:#8ff0b8;--ok-bd:rgba(110,231,160,.35);\n' +
    '  --err-bg:rgba(255,95,109,.14);--err-fg:#ff9aa2;--err-bd:rgba(255,95,109,.4);\n' +
    '  --cancelled-bg:rgba(255,255,255,.08);--cancelled-fg:#a9adbd;--cancelled-bd:rgba(255,255,255,.14);\n' +
    '}\n' +
    ':root[data-theme="light"]{\n' +
    '  color-scheme:light;\n' +
    '  --canvas:#f3f2fb;\n' +
    '  --surface:#ffffff;\n' +
    '  --surface-raised:#ecebf8;\n' +
    '  --surface-tint:rgba(40,41,61,.06);\n' +
    '  --primary:#28293d;\n' +
    '  --primary-hover:#353858;\n' +
    '  --brand:#6842ff;\n' +
    '  --brand-hover:#7a5aff;\n' +
    '  --brand-soft:#5b3fd4;\n' +
    '  --on-brand:#f9faff;\n' +
    '  --text:#1c1e2e;\n' +
    '  --text-2:#3c3f55;\n' +
    '  --text-3:#70738c;\n' +
    '  --divider:rgba(40,41,61,.14);\n' +
    '  --error:#d63a49;\n' +
    '  --ok:#2faf6f;\n' +
    '  --warn:#b97d0a;\n' +
    '  --glow:rgba(104,66,255,.10);\n' +
    '  --glass-bg:rgba(255,255,255,.62);\n' +
    '  --glass-edge:rgba(104,66,255,.30);\n' +
    '  --glass-hi:rgba(255,255,255,.75);\n' +
    '  --sel-bg:rgba(104,66,255,.12);\n' +
    '  --ghost-bg:rgba(104,66,255,.07);\n' +
    '  --ghost-fg:#2f3148;\n' +
    '  --ghost-hover:rgba(104,66,255,.12);\n' +
    '  --bar-track:rgba(40,41,61,.10);\n' +
    '  --shadow-1:rgba(31,34,60,.06) 0px 2px 5px -1px,rgba(31,34,60,.05) 0px 2px 8px 0px,rgba(31,34,60,.04) 0px 1px 12px 0px;\n' +
    '  --shadow-2:rgba(31,34,60,.16) 0px 14px 44px 0px;\n' +
    '  --glass-shadow:0 10px 30px -22px rgba(31,34,60,.35);\n' +
    '  --queued-bg:rgba(104,66,255,.10);--queued-fg:#5b3fd4;--queued-bd:rgba(104,66,255,.35);\n' +
    '  --ok-bg:rgba(47,175,111,.12);--ok-fg:#157a48;--ok-bd:rgba(47,175,111,.35);\n' +
    '  --err-bg:rgba(214,58,73,.10);--err-fg:#c22a38;--err-bd:rgba(214,58,73,.35);\n' +
    '  --cancelled-bg:rgba(40,41,61,.06);--cancelled-fg:#6b6e86;--cancelled-bd:rgba(40,41,61,.16);\n' +
    '}\n' +
    'html,body{margin:0;padding:0}\n' +
    '*,*::before,*::after{box-sizing:border-box}\n' +
    'body{font-family:"Nunito","Quicksand",ui-rounded,system-ui,-apple-system,"Segoe UI",sans-serif;background:radial-gradient(1100px 420px at 50% -10%,var(--glow),transparent 62%),var(--canvas);color:var(--text);line-height:1.55;font-size:14px;min-height:100vh}\n' +
    '.appbar{display:flex;align-items:center;gap:14px;padding:14px 22px;position:sticky;top:0;z-index:5;background:var(--glass-bg);-webkit-backdrop-filter:blur(14px) saturate(150%);backdrop-filter:blur(14px) saturate(150%);border-bottom:1px solid var(--glass-edge);box-shadow:0 1px 0 var(--glass-hi) inset,var(--glass-shadow)}\n' +
    '@media (max-width:640px){.appbar{padding:12px 16px;gap:10px}.appbar p{display:none}}\n' +
    '.logo{display:grid;place-items:center;width:42px;height:42px;border-radius:22px;background:var(--brand);color:#fff;font-size:1.25rem;box-shadow:0 0 0 1px rgba(104,66,255,.4),0 8px 24px rgba(104,66,255,.35)}\n' +
    '.logo svg{width:26px;height:26px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    '.btn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}\n' +
    '.appbar h1{margin:0;font-size:1.2rem;font-weight:800}\n' +
    '.appbar p{margin:0;font-size:.85rem;color:var(--text-2);opacity:.85}\n' +
    'main{padding:22px 22px 56px}\n' +
    '.card{background:var(--surface);border:1px solid var(--divider);border-radius:var(--radius-card);box-shadow:var(--shadow-1);padding:20px;margin:16px 0}\n' +
    '.section-title{margin:0 0 14px;font-size:.75rem;font-weight:800;color:var(--brand-soft);text-transform:uppercase;letter-spacing:.12em}\n' +
    '.field{width:100%;border:1px solid var(--divider);border-radius:var(--radius-med);padding:12px 14px;font:inherit;background:var(--surface-raised);color:var(--text);resize:vertical}\n' +
    '.field::placeholder{color:var(--text-3)}\n' +
    '.field:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(104,66,255,.28)}\n' +
    '.row{display:flex;gap:10px;margin-top:14px;align-items:center;flex-wrap:wrap}\n' +
    '.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:none;border-radius:var(--radius-pill);padding:10px 24px;font:inherit;font-weight:700;font-size:.9rem;cursor:pointer;transition:transform .08s,box-shadow .15s,background .15s,opacity .15s}\n' +
    '.btn:hover{transform:translateY(-1px)}\n' +
    '.btn:active{transform:translateY(0)}\n' +
    '.btn:disabled{cursor:wait;opacity:.55;transform:none}\n' +
    '.btn.primary{background:var(--brand);color:var(--on-brand);box-shadow:var(--shadow-1)}\n' +
    '.btn.primary:hover{background:var(--brand-hover)}\n' +
    '.btn.dark{background:var(--primary);color:#ffffff;box-shadow:var(--shadow-1)}\n' +
    '.btn.dark:hover{background:var(--primary-hover)}\n' +
    '.btn.ghost{background:var(--ghost-bg);color:var(--ghost-fg);box-shadow:none}\n' +
    '.btn.ghost:hover{background:var(--ghost-hover)}\n' +
    '.btn.light{background:#f9faff;color:#2f3148;box-shadow:var(--shadow-1)}\n' +
    '.btn.light:hover{background:#ffffff}\n' +
    '.btn.danger{background:var(--error);color:#fff;box-shadow:var(--shadow-1)}\n' +
    '.btn.danger:hover{filter:brightness(1.08)}\n' +
    '.theme-btn{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:999px;background:var(--ghost-bg);border:1px solid var(--divider);color:var(--text-2);cursor:pointer;transition:background .15s,color .15s}\n' +
    '.theme-btn:hover{background:var(--ghost-hover);color:var(--text)}\n' +
    '.nav-tabs{display:flex;gap:8px}\n' +
    '.nav-tabs a{display:inline-flex;align-items:center;gap:6px;padding:8px 18px;border-radius:var(--radius-pill);background:var(--ghost-bg);color:var(--ghost-fg);font-weight:700;font-size:.85rem;text-decoration:none;transition:background .15s,color .15s}\n' +
    '.nav-tabs a:hover{background:var(--ghost-hover)}\n' +
    '.nav-tabs a.active{background:var(--brand);color:var(--on-brand)}\n' +
    '.nav-tabs a svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    '@media (max-width:860px){.nav-tabs a span{display:none}.nav-tabs a{padding:8px 12px}}\n' +
    '.theme-btn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    '.table-wrap{overflow-x:auto;border-radius:var(--radius-med);border:1px solid var(--divider);background:var(--canvas)}\n' +
    'table{border-collapse:collapse;width:100%;font-size:.88rem}\n' +
    'th{text-align:left;padding:12px 14px;background:var(--surface-raised);color:var(--brand-soft);font-weight:800;font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;white-space:nowrap}\n' +
    'td{padding:12px 14px;border-top:1px solid var(--divider);vertical-align:top;color:var(--text-2);overflow-wrap:anywhere}\n' +
    'tr.job{cursor:pointer;transition:background .12s}\n' +
    'tr.job:hover{background:var(--surface-tint)}\n' +
    'tr.job.sel{background:var(--sel-bg)}\n' +
    '.pill{display:inline-block;padding:3px 12px;border-radius:999px;font-size:.74rem;font-weight:800;letter-spacing:.03em;white-space:nowrap;border:1px solid transparent}\n' +
    '.queued,.detecting,.resolving,.downloading,.extracting,.validating,.uploading{background:var(--queued-bg);color:var(--queued-fg);border-color:var(--queued-bd)}\n' +
    '.completed{background:var(--ok-bg);color:var(--ok-fg);border-color:var(--ok-bd)}\n' +
    '.failed{background:var(--err-bg);color:var(--err-fg);border-color:var(--err-bd)}\n' +
    '.cancelled{background:var(--cancelled-bg);color:var(--cancelled-fg);border-color:var(--cancelled-bd)}\n' +
    '.bar{height:6px;background:var(--bar-track);border-radius:999px;overflow:hidden;margin:12px 0}\n' +
    '.bar>i{display:block;height:100%;background:var(--brand);border-radius:999px;transition:width .3s;box-shadow:0 0 8px rgba(104,66,255,.6)}\n' +
    'pre{background:var(--canvas);border:1px solid var(--divider);border-radius:var(--radius-sm);padding:12px;overflow:auto;max-width:100%;max-height:240px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8rem;font-family:ui-monospace,Consolas,monospace;color:var(--text-2)}\n' +
    '.runbox{position:relative}\n' +
    '.copy-btn{position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:var(--surface-raised);border:1px solid var(--divider);color:var(--text-2);cursor:pointer;transition:background .15s,color .15s}\n' +
    '.copy-btn:hover{background:var(--surface-tint);color:var(--text)}\n' +
    '.copy-btn.copied{color:var(--ok);border-color:rgba(110,231,160,.35)}\n' +
    '.copy-btn svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    'code{background:var(--surface-raised);padding:2px 6px;border-radius:6px;font-family:ui-monospace,Consolas,monospace;font-size:.85em;color:var(--text-2);overflow-wrap:anywhere}\n' +
    '.err{color:var(--error);font-size:.9rem;margin-top:8px;overflow-wrap:anywhere}\n' +
    '.dup-list{margin-top:10px;max-height:160px;color:var(--warn)}\n' +
    '.dup-list[hidden]{display:none}\n' +
    '.warn{color:var(--warn)}\n' +
    '.ok{color:var(--ok)}\n' +
    '.muted{color:var(--text-3);font-size:.85rem;overflow-wrap:anywhere}\n' +
    '.row>span,.row>code{min-width:0}\n' +
    '.detail-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 16px;margin-top:10px;font-size:.9rem}\n' +
    '.detail-kv b{color:var(--brand-soft);font-weight:800;font-size:.74rem;text-transform:uppercase;letter-spacing:.08em;padding-top:2px}\n' +
    '.detail-kv>span{min-width:0;overflow-wrap:anywhere}\n' +
    '.row .field{flex:1;width:auto;min-width:180px}\n' +
    '.modal{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:20px;background:rgba(10,11,18,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}\n' +
    '.modal[hidden]{display:none}\n' +
    '.modal-panel{width:min(740px,100%);max-height:min(80vh,720px);display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--divider);border-radius:var(--radius-card);box-shadow:var(--shadow-2);overflow:hidden}\n' +
    '.modal-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--divider)}\n' +
    '.modal-title{margin:0;font-size:1rem;font-weight:800;flex:1;min-width:0}\n' +
    '.modal-list{overflow-y:auto;padding:8px 0;min-height:120px}\n' +
    '.modal-foot{display:flex;align-items:center;gap:10px;padding:14px 18px;border-top:1px solid var(--divider);flex-wrap:wrap}\n' +
    '.grow{display:flex;align-items:center;gap:12px;padding:8px 18px;cursor:pointer;border-radius:var(--radius-med)}\n' +
    '.grow:hover{background:var(--surface-tint)}\n' +
    '.grow input[type=checkbox]{width:17px;height:17px;accent-color:var(--brand);flex:none;cursor:pointer}\n' +
    '.grow img.thumb{width:56px;height:56px;object-fit:cover;border-radius:var(--radius-sm);background:var(--surface-raised);flex:none}\n' +
    '.grow span.thumb{width:56px;height:56px;border-radius:var(--radius-sm);background:var(--surface-raised);flex:none}\n' +
    '.grow .tt{min-width:0;flex:1}\n' +
    '.grow .tt b{display:block;font-size:.9rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n' +
    '.grow .tt small{display:block;color:var(--text-3);font-size:.74rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n' +
    '.badge{padding:2px 10px;border-radius:999px;font-size:.7rem;font-weight:800;background:var(--ok-bg);color:var(--ok-fg);border:1px solid var(--ok-bd);white-space:nowrap;flex:none}\n' +
    '.pager{margin-top:14px;justify-content:flex-end}\n' +
    '.pager #jobsPageInfo{margin-right:auto}\n' +
    '.pager-size{display:inline-flex;align-items:center;font-size:.82rem;white-space:nowrap}\n' +
    '.pager .btn:disabled{cursor:not-allowed}\n' +
    '.workbench{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(320px,1fr);gap:16px;align-items:start;margin:16px 0}\n' +
    '.filters{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 14px}\n' +
    '.filter-sel{width:auto;min-width:150px;padding:9px 12px;font-size:.85rem}\n' +
    '.filters .btn{padding:9px 18px;font-size:.85rem}\n' +
    '.workbench .card{margin:0}\n' +
    '.workbench-right{position:sticky;top:86px;max-height:calc(100vh - 106px);display:flex;flex-direction:column;overflow:hidden}\n' +
    '.workbench-right #detail{overflow-y:auto;min-height:200px}\n' +
    '.workbench-right #detail.muted{padding:12px 4px}\n' +
    '@media (max-width:980px){.workbench{grid-template-columns:1fr}.workbench-right{position:static;max-height:none}}\n' +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<header class="appbar">\n' +
    '<span class="logo"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59c-.007.052-.01.101-.017.152C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.41.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.54-.6-6.58-.68-7.26-.01-.05-.01-.1-.02-.15A4 4 0 0 0 17.32 5z"/><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/></svg></span>\n' +
    '<div>\n' +
    '<h1 id="consoleTitle">Game Import Console</h1>\n' +
    '<p>Import authorized HTML5/Unity games, watch progress, inspect diagnostics, and get local run instructions.</p>\n' +
    '</div>\n' +
    '<nav class="nav-tabs">\n' +
    '<a href="/" id="homeTab"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg><span>Folders</span></a>\n' +
    '<a href="/console/settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><span>Settings</span></a>\n' +
    '</nav>\n' +
    '<button id="themeBtn" class="theme-btn" type="button" aria-label="Toggle color theme" title="Toggle light/dark">\n' +
    '<svg id="themeIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>\n' +
    '</button>\n' +
    '</header>\n' +
    '<main>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Add games</h2>\n' +
    '<form id="startForm">\n' +
    '<textarea id="sourceUrls" class="field" rows="3" placeholder="https://www.crazygames.com/game/…\nOne game URL per line — multiple games at once"></textarea>\n' +
    '<div class="row">\n' +
    '<button type="submit" id="startBtn" class="btn primary">Start imports</button>\n' +
    '<span id="formStatus" class="muted"></span>\n' +
    '</div>\n' +
    '<div id="formError" class="err"></div>\n' +
    '<pre id="formDupList" class="dup-list" hidden></pre>\n' +
    '</form>\n' +
    '</section>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Discover from a listing</h2>\n' +
    '<div class="row" style="margin-top:0">\n' +
    '<input id="discoverUrl" class="field" type="url" placeholder="https://www.crazygames.com/c/action" title="Paste any CrazyGames listing page: category, tag, or home.">\n' +
    '<button type="button" id="discoverBtn" class="btn primary"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Discover</button>\n' +
    '</div>\n' +
    '<div id="discoverStatus" class="muted"></div>\n' +
    '<div id="discoverError" class="err"></div>\n' +
    '</section>\n' +
    '<div class="workbench">\n' +
    '<section class="card workbench-left">\n' +
    '<h2 class="section-title">Jobs</h2>\n' +
    '<div class="filters">\n' +
    '<select id="filterStatus" class="field filter-sel" title="Filter by status">\n' +
    '<option value="">All statuses</option>\n' +
    '<optgroup label="In flight">\n' +
    '<option value="queued">Queued</option>\n' +
    '<option value="detecting">Detecting</option>\n' +
    '<option value="resolving">Resolving</option>\n' +
    '<option value="downloading">Downloading</option>\n' +
    '<option value="extracting">Extracting</option>\n' +
    '<option value="validating">Validating</option>\n' +
    '<option value="uploading">Uploading</option>\n' +
    '</optgroup>\n' +
    '<optgroup label="Terminal">\n' +
    '<option value="completed">Completed</option>\n' +
    '<option value="failed">Failed</option>\n' +
    '<option value="cancelled">Cancelled</option>\n' +
    '</optgroup>\n' +
    '</select>\n' +
    '<select id="sortKey" class="field filter-sel" title="Sort by">\n' +
    '<option value="updatedAt" selected>Recently updated</option>\n' +
    '<option value="seq">Job number</option>\n' +
    '<option value="status">Status</option>\n' +
    '<option value="progress">Progress</option>\n' +
    '</select>\n' +
    '<button id="sortDir" class="btn ghost" type="button" title="Toggle sort direction" aria-label="Toggle sort direction"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>Desc</button>\n' +
    '</div>\n' +
    '<div class="table-wrap">\n' +
    '<table><thead><tr><th>#</th><th>Source</th><th>Status</th><th>Progress</th><th>Updated</th></tr></thead>\n' +
    '<tbody id="jobRows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table>\n' +
    '</div>\n' +
    '<div class="row pager">\n' +
    '<button id="jobsPrevBtn" class="btn ghost" type="button" title="Previous page"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="15 18 9 12 15 6"/></svg>Prev</button>\n' +
    '<span id="jobsPageInfo" class="muted"></span>\n' +
    '<button id="jobsNextBtn" class="btn ghost" type="button" title="Next page">Next<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="9 18 15 12 9 6"/></svg></button>\n' +
    '<label class="pager-size muted">Per page\n' +
    '<select id="jobsPageSize" class="field" style="width:auto;padding:8px 12px;margin-left:8px">\n' +
    '<option value="25">25</option>\n' +
    '<option value="50" selected>50</option>\n' +
    '<option value="100">100</option>\n' +
    '</select>\n' +
    '</label>\n' +
    '</div>\n' +
    '</section>\n' +
    '<section class="card workbench-right">\n' +
    '<h2 class="section-title">Details</h2>\n' +
    '<div id="detail" class="muted">Select a job to inspect it.</div>\n' +
    '</section>\n' +
    '</div>\n' +
    '</main>\n' +
    '<div id="discoverModal" class="modal" hidden>\n' +
    '<div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="discoverModalTitle">\n' +
    '<div class="modal-head"><h2 id="discoverModalTitle" class="modal-title">Games on this page</h2>\n' +
    '<button id="discoverCloseBtn" class="copy-btn" style="position:static" type="button" aria-label="Close dialog">\n' +
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>\n' +
    '</button></div>\n' +
    '<div id="discoverList" class="modal-list"></div>\n' +
    '<div class="modal-foot">\n' +
    '<button id="discoverSelectAllBtn" class="btn ghost" type="button">Select all</button>\n' +
    '<button id="discoverClearBtn" class="btn ghost" type="button">Clear</button>\n' +
    '<span id="discoverCount" class="muted" style="margin-left:auto"></span>\n' +
    '<button id="discoverAddBtn" class="btn primary" type="button"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add selected</button>\n' +
    '</div>\n' +
    '</div>\n' +
    '</div>\n' +
    '<script>\n' +
    '(function () {\n' +
    '  "use strict";\n' +
    '  var FOLDER_ID = ' +
    JSON.stringify(folderId) +
    ';\n' +
    '  var selectedId = null;\n' +
    '  var activeTimer = null;\n' +
    '  var pollTimer = null;\n' +
    '  var jobPage = 1;\n' +
    '  var jobPageSize = 50;\n' +
    '  var jobTotal = 0;\n' +
    '  var jobTotalPages = 1;\n' +
    '  var jobStatusFilter = "";\n' +
    '  var jobSortKey = "updatedAt";\n' +
    '  var jobSortDir = "DESC";\n' +
    '  var IN_FLIGHT = ["queued", "detecting", "resolving", "downloading", "extracting", "validating", "uploading"];\n' +
    '  var COPY_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><rect x=\\"9\\" y=\\"9\\" width=\\"13\\" height=\\"13\\" rx=\\"2\\"/><path d=\\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\\"/></svg>";\n' +
    '  var CHECK_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"M20 6L9 17l-5-5\\"/></svg>";\n' +
    '  var SUN_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><circle cx=\\"12\\" cy=\\"12\\" r=\\"5\\"/><line x1=\\"12\\" y1=\\"1\\" x2=\\"12\\" y2=\\"3\\"/><line x1=\\"12\\" y1=\\"21\\" x2=\\"12\\" y2=\\"23\\"/><line x1=\\"4.22\\" y1=\\"4.22\\" x2=\\"5.64\\" y2=\\"5.64\\"/><line x1=\\"18.36\\" y1=\\"18.36\\" x2=\\"19.78\\" y2=\\"19.78\\"/><line x1=\\"1\\" y1=\\"12\\" x2=\\"3\\" y2=\\"12\\"/><line x1=\\"21\\" y1=\\"12\\" x2=\\"23\\" y2=\\"12\\"/><line x1=\\"4.22\\" y1=\\"19.78\\" x2=\\"5.64\\" y2=\\"18.36\\"/><line x1=\\"18.36\\" y1=\\"5.64\\" x2=\\"19.78\\" y2=\\"4.22\\"/></svg>";\n' +
    '  var MOON_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z\\"/></svg>";\n' +
    '  function applyTheme(t) {\n' +
    '    document.documentElement.setAttribute("data-theme", t);\n' +
    '    var ic = document.getElementById("themeIcon");\n' +
    '    if (ic) ic.innerHTML = t === "light" ? MOON_ICON : SUN_ICON;\n' +
    '    try { localStorage.setItem("cg2-theme", t); } catch (e) {}\n' +
    '  }\n' +
    '  function initTheme() {\n' +
    '    var t = document.documentElement.getAttribute("data-theme");\n' +
    '    if (t !== "light" && t !== "dark") t = "dark";\n' +
    '    applyTheme(t);\n' +
    '    var btn = document.getElementById("themeBtn");\n' +
    '    if (btn) btn.addEventListener("click", function () {\n' +
    '      var cur = document.documentElement.getAttribute("data-theme");\n' +
    '      applyTheme(cur === "light" ? "dark" : "light");\n' +
    '    });\n' +
    '  }\n' +
    '  function esc(s) {\n' +
    '    return String(s == null ? "" : s).replace(/[&<>"\']/g, function (c) {\n' +
    '      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\\"": "&quot;", "\\u0027": "&#39;" }[c];\n' +
    '    });\n' +
    '  }\n' +
    '  function api(path, opts) {\n' +
    '    return fetch(path, opts).then(function (r) {\n' +
    '      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (b) {\n' +
    '        throw new Error((b && b.message) || ("Request failed: " + r.status));\n' +
    '      });\n' +
    '      return r.json();\n' +
    '    });\n' +
    '  }\n' +
    '  function shortId(id) { return esc(String(id).slice(0, 8)); }\n' +
    '  function jobsQuery() {\n' +
    '    var q = "?page=" + jobPage + "&limit=" + jobPageSize + "&folderId=" + encodeURIComponent(FOLDER_ID) +\n' +
    '      "&sort=" + encodeURIComponent(jobSortKey) + "&dir=" + jobSortDir;\n' +
    '    if (jobStatusFilter) q += "&status=" + encodeURIComponent(jobStatusFilter);\n' +
    '    return q;\n' +
    '  }\n' +
    '  function loadJobs() {\n' +
    '    api("/game-imports" + jobsQuery()).then(function (data) {\n' +
    '      var tb = document.getElementById("jobRows");\n' +
    '      var jobs = data.items || [];\n' +
    '      jobTotal = data.total;\n' +
    '      jobTotalPages = data.totalPages || 1;\n' +
    '      if (jobPage > jobTotalPages) { jobPage = Math.max(jobTotalPages, 1); }\n' +
    '      renderJobsPager();\n' +
    '      if (!jobs.length) { tb.innerHTML = "<tr><td colspan=\\"5\\" class=\\"muted\\">No jobs match.</td></tr>"; return; }\n' +
    '      var html = "";\n' +
    '      jobs.forEach(function (j) {\n' +
    '        html += "<tr class=\\"job" + (j.id === selectedId ? " sel" : "") + "\\" data-id=\\"" + esc(j.id) + "\\">" +\n' +
    '          "<td><code>#" + (j.seq != null ? esc(j.seq) : "?") + "</code></td>" +\n' +
    '          "<td>" + esc(j.sourceUrl) + "</td>" +\n' +
    '          "<td><span class=\\"pill " + esc(j.status) + "\\">" + esc(j.status) + "</span></td>" +\n' +
    '          "<td>" + esc(j.progress) + "%</td>" +\n' +
    '          "<td class=\\"muted\\">" + esc(j.updatedAt) + "</td></tr>";\n' +
    '      });\n' +
    '      tb.innerHTML = html;\n' +
    '      Array.prototype.forEach.call(tb.querySelectorAll("tr.job"), function (tr) {\n' +
    '        tr.addEventListener("click", function () { selectJob(tr.getAttribute("data-id")); });\n' +
    '      });\n' +
    '      // Poll only while something is actually running; stay silent when idle.\n' +
    '      if (jobs.some(function (j) { return IN_FLIGHT.indexOf(j.status) >= 0; })) {\n' +
    '        startPoll();\n' +
    '      } else {\n' +
    '        stopPoll();\n' +
    '      }\n' +
    '    }).catch(function (e) {\n' +
    '      document.getElementById("jobRows").innerHTML = "<tr><td colspan=\\"5\\" class=\\"err\\">" + esc(e.message) + "</td></tr>";\n' +
    '    });\n' +
    '  }\n' +
    '  function startPoll() {\n' +
    '    if (pollTimer) return;\n' +
    '    pollTimer = setInterval(loadJobs, 5000);\n' +
    '  }\n' +
    '  function stopPoll() {\n' +
    '    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }\n' +
    '  }\n' +
    '  function renderJobsPager() {\n' +
    '    var info = document.getElementById("jobsPageInfo");\n' +
    '    if (info) info.textContent = "Page " + jobPage + " of " + jobTotalPages + " · " + jobTotal + " job" + (jobTotal === 1 ? "" : "s");\n' +
    '    var prev = document.getElementById("jobsPrevBtn");\n' +
    '    var next = document.getElementById("jobsNextBtn");\n' +
    '    if (prev) prev.disabled = jobPage <= 1;\n' +
    '    if (next) next.disabled = jobPage >= jobTotalPages;\n' +
    '  }\n' +
    '  function gotoJobsPage(p) {\n' +
    '    jobPage = Math.max(1, p);\n' +
    '    loadJobs();\n' +
    '  }\n' +
    '  function diagList(ds) {\n' +
    '    if (!ds || !ds.length) return "<p class=\\"muted\\">No diagnostics.</p>";\n' +
    '    var html = "<table><thead><tr><th>Level</th><th>Code</th><th>Message</th></tr></thead><tbody>";\n' +
    '    ds.forEach(function (d) {\n' +
    '      var cls = d.level === "error" ? "err" : (d.level === "warning" ? "warn" : "ok");\n' +
    '      html += "<tr><td class=\\"" + cls + "\\">" + esc(d.level) + "</td><td><code>" + esc(d.code) + "</code></td><td>" + esc(d.message) + "</td></tr>";\n' +
    '    });\n' +
    '    return html + "</tbody></table>";\n' +
    '  }\n' +
    '  function runHelp(pkgPath, jobId) {\n' +
    '    if (!pkgPath) return "";\n' +
    '    return "<h3 class=\\"section-title\\">Run locally</h3>" +\n' +
    '      "<div class=\\"runbox\\"><pre id=\\"runCmd\\">cd \\"" + pkgPath.replace(/\\"/g, "") + "\\"" +\n' +
    '      "\\npython -m http.server 8080</pre>" +\n' +
    '      "<button id=\\"copyRunBtn\\" class=\\"copy-btn\\" title=\\"Copy command\\" aria-label=\\"Copy command\\">" +\n' +
    '      COPY_ICON + "</button></div>" +\n' +
    '      "<p class=\\"muted\\">Open <code>http://localhost:8080</code> — serve over HTTP, never <code>file://</code> (Unity WebGL requires HTTP). " +\n' +
    '      "Then check DevTools Console/Network for failed game assets.</p>" +\n' +
    '      "<div class=\\"row\\" style=\\"margin-top:10px\\">" +\n' +
    '      "<button id=\\"runBtn\\" class=\\"btn primary\\"><svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\" focusable=\\"false\\"><polygon points=\\"6 3 20 12 6 21 6 3\\"/></svg>Start</button>" +\n' +
    '      "<button id=\\"stopBtn\\" class=\\"btn light\\" disabled><svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\" focusable=\\"false\\"><rect x=\\"6\\" y=\\"6\\" width=\\"12\\" height=\\"12\\" rx=\\"2\\"/></svg>Stop</button>" +\n' +
    '      "<span id=\\"runStatus\\" class=\\"muted\\"></span></div>";\n' +
    '  }\n' +
    '  function runGame(jobId) {\n' +
    '    var status = document.getElementById("runStatus");\n' +
    '    var runBtn = document.getElementById("runBtn");\n' +
    '    var stopBtn = document.getElementById("stopBtn");\n' +
    '    status.textContent = "Starting…";\n' +
    '    runBtn.disabled = true;\n' +
    '    api("/game-imports/" + encodeURIComponent(jobId) + "/run", { method: "POST" }).then(function (r) {\n' +
    '      status.textContent = "Running at " + r.url;\n' +
    '      stopBtn.disabled = false;\n' +
    '    }, function (e) {\n' +
    '      status.textContent = "";\n' +
    '      runBtn.disabled = false;\n' +
    '      alert(e.message);\n' +
    '    });\n' +
    '  }\n' +
    '  function stopGame(jobId) {\n' +
    '    var status = document.getElementById("runStatus");\n' +
    '    var runBtn = document.getElementById("runBtn");\n' +
    '    var stopBtn = document.getElementById("stopBtn");\n' +
    '    status.textContent = "Stopping…";\n' +
    '    stopBtn.disabled = true;\n' +
    '    api("/game-imports/" + encodeURIComponent(jobId) + "/stop", { method: "POST" }).then(function () {\n' +
    '      status.textContent = "Stopped.";\n' +
    '      runBtn.disabled = false;\n' +
    '    }, function (e) {\n' +
    '      status.textContent = "";\n' +
    '      stopBtn.disabled = false;\n' +
    '      alert(e.message);\n' +
    '    });\n' +
    '  }\n' +
    '  function copyRun() {\n' +
    '    var pre = document.getElementById("runCmd");\n' +
    '    var btn = document.getElementById("copyRunBtn");\n' +
    '    if (!pre || !btn) return;\n' +
    '    var text = pre.textContent.trim();\n' +
    '    var done = function () {\n' +
    '      btn.innerHTML = CHECK_ICON;\n' +
    '      btn.classList.add("copied");\n' +
    '      setTimeout(function () {\n' +
    '        btn.innerHTML = COPY_ICON;\n' +
    '        btn.classList.remove("copied");\n' +
    '      }, 1500);\n' +
    '    };\n' +
    '    var legacy = function () {\n' +
    '      var ta = document.createElement("textarea");\n' +
    '      ta.value = text;\n' +
    '      ta.style.position = "fixed";\n' +
    '      ta.style.opacity = "0";\n' +
    '      document.body.appendChild(ta);\n' +
    '      ta.select();\n' +
    '      var ok = false;\n' +
    '      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }\n' +
    '      document.body.removeChild(ta);\n' +
    '      if (ok) done();\n' +
    '    };\n' +
    '    if (navigator.clipboard && navigator.clipboard.writeText) {\n' +
    '      navigator.clipboard.writeText(text).then(done, legacy);\n' +
    '    } else {\n' +
    '      legacy();\n' +
    '    }\n' +
    '  }\n' +
    '  function renderDetail(j, logs) {\n' +
    '    var el = document.getElementById("detail");\n' +
    '    var html = "<div class=\\"row\\" style=\\"margin-top:0\\"><span class=\\"pill " + esc(j.status) + "\\">" + esc(j.status) + "</span> " +\n' +
    '      "<code>" + esc(j.id) + "</code></div>" +\n' +
    '      "<div class=\\"detail-kv\\">" +\n' +
    '      "<b>Source</b><span>" + esc(j.sourceUrl) + "</span>" +\n' +
    '      "<b>Step</b><span>" + esc(j.currentStep) + "</span>" +\n' +
    '      "<b>Engine</b><span>" + esc(j.detectedEngine || "—") + "</span>" +\n' +
    '      "<b>Files</b><span>" + esc(j.downloadedFiles) + " / " + esc(j.totalFiles) + "</span>" +\n' +
    '      "</div>" +\n' +
    '      "<div class=\\"bar\\"><i style=\\"width:" + esc(j.progress) + "%\\"></i></div>";\n' +
    '    if (j.status === "failed") {\n' +
    '      html += "<p class=\\"err\\"><strong>Failed" + (j.errorCode ? " (" + esc(j.errorCode) + ")" : "") + ":</strong> " + esc(j.error) + "</p>";\n' +
    '      if (j.packageUrl) html += "<p><strong>Partial package:</strong> <code>" + esc(j.packageUrl) + "</code></p>";\n' +
    '    }\n' +
    '    if (j.status === "completed") {\n' +
    '      html += "<p class=\\"ok\\"><strong>Package:</strong> <code>" + esc(j.packageUrl) + "</code></p>" + runHelp(j.packageUrl, j.id);\n' +
    '    }\n' +
    '    if (["failed", "completed", "cancelled"].indexOf(j.status) >= 0) {\n' +
    '      html += "<p><button id=\\"reimportBtn\\" class=\\"btn ghost\\"><svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"M23 4v6h-6\\"/><path d=\\"M20.49 15a9 9 0 1 1-2.12-9.36L23 10\\"/></svg>Re-import</button> <span class=\\"muted\\">Forces a fresh run even though this game already exists.</span></p>";\n' +
    '    }\n' +
    '    if (["failed", "completed", "cancelled"].indexOf(j.status) >= 0) {\n' +
    '      html += "<p><button id=\\"deleteJobBtn\\" class=\\"btn danger\\"><svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><polyline points=\\"3 6 5 6 21 6\\"/><path d=\\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\\"/></svg>Delete job</button> <span class=\\"muted\\">Removes the job and its package from disk.</span></p>";\n' +
    '    }\n' +
    '    if (["queued", "detecting", "resolving", "downloading", "extracting", "validating", "uploading"].indexOf(j.status) >= 0) {\n' +
    '      html += "<p><button id=\\"cancelBtn\\" class=\\"btn light\\">Cancel job</button></p>";\n' +
    '    }\n' +
    '    html += "<h3 class=\\"section-title\\">Diagnostics</h3>" + diagList(j.diagnostics);\n' +
    '    html += "<h3 class=\\"section-title\\">Logs</h3><pre>" + esc((logs || []).map(function (l) { return l.at + " [" + l.level + "] " + l.message; }).join("\\n")) + "</pre>";\n' +
    '    el.innerHTML = html;\n' +
    '    el.classList.remove("muted");\n' +
    '  var cp = document.getElementById("copyRunBtn");\n' +
    '  if (cp) cp.addEventListener("click", copyRun);\n' +
    '  var runBtn = document.getElementById("runBtn");\n' +
    '  if (runBtn) runBtn.addEventListener("click", function () { runGame(selectedId); });\n' +
    '  var stopBtn = document.getElementById("stopBtn");\n' +
    '  if (stopBtn) stopBtn.addEventListener("click", function () { stopGame(selectedId); });\n' +
    '    var cb = document.getElementById("cancelBtn");\n' +
    '    if (cb) cb.addEventListener("click", function () {\n' +
    '      cb.disabled = true;\n' +
    '      api("/game-imports/" + encodeURIComponent(j.id) + "/cancel", { method: "POST" }).then(refreshSelected, function (e) {\n' +
    '        cb.disabled = false; alert(e.message);\n' +
    '      });\n' +
    '    });\n' +
    '    var rb = document.getElementById("reimportBtn");\n' +
    '    if (rb) rb.addEventListener("click", function () {\n' +
    '      rb.disabled = true;\n' +
    '      var body = { sourceUrl: j.sourceUrl, force: true };\n' +
    '      var folderScope = j.folderId ? j.folderId : (FOLDER_ID === "none" ? null : FOLDER_ID);\n' +
    '      if (folderScope) body.folderId = folderScope;\n' +
    '      api("/game-imports", {\n' +
    '        method: "POST",\n' +
    '        headers: { "Content-Type": "application/json" },\n' +
    '        body: JSON.stringify(body)\n' +
    '      }).then(function (nj) { selectJob(nj.id); }, function (e) { rb.disabled = false; alert(e.message); });\n' +
    '    });\n' +
    '    var db = document.getElementById("deleteJobBtn");\n' +
    '    if (db) db.addEventListener("click", function () {\n' +
    '      var label = j.seq != null ? ("job #" + j.seq) : "this job";\n' +
    '      if (!window.confirm("Delete " + label + "?\\nThis removes its package from disk.")) return;\n' +
    '      db.disabled = true;\n' +
    '      api("/game-imports/" + encodeURIComponent(j.id), { method: "DELETE" }).then(function () {\n' +
    '        if (activeTimer) { clearInterval(activeTimer); activeTimer = null; }\n' +
    '        selectedId = null;\n' +
    '        var el = document.getElementById("detail");\n' +
    '        el.innerHTML = "<p class=\\"ok\\">Job deleted (package removed from disk).</p>";\n' +
    '        el.classList.remove("muted");\n' +
    '        jobPage = 1;\n' +
    '        loadJobs();\n' +
    '      }, function (e) {\n' +
    '        db.disabled = false;\n' +
    '        alert(e.message);\n' +
    '      });\n' +
    '    });\n' +
    '  }\n' +
    '  var TERMINAL = ["completed", "failed", "cancelled"];\n' +
    '  function refreshSelected() {\n' +
    '    if (!selectedId) return;\n' +
    '    api("/game-imports/" + encodeURIComponent(selectedId)).then(function (j) {\n' +
    '      api("/game-imports/" + encodeURIComponent(selectedId) + "/logs").then(function (logs) {\n' +
    '        renderDetail(j, logs);\n' +
    '        loadJobs();\n' +
    '        if (activeTimer) { clearInterval(activeTimer); activeTimer = null; }\n' +
    '        if (TERMINAL.indexOf(j.status) < 0) {\n' +
    '          activeTimer = setInterval(refreshSelected, 2000);\n' +
    '        }\n' +
    '      });\n' +
    '    }).catch(function (e) {\n' +
    '      document.getElementById("detail").innerHTML = "<p class=\\"err\\">" + esc(e.message) + "</p>";\n' +
    '    });\n' +
    '  }\n' +
    '  function selectJob(id) { selectedId = id; refreshSelected(); }\n' +
    '  document.getElementById("startForm").addEventListener("submit", function (ev) {\n' +
    '    ev.preventDefault();\n' +
    '    var btn = document.getElementById("startBtn");\n' +
    '    var err = document.getElementById("formError");\n' +
    '    var status = document.getElementById("formStatus");\n' +
    '    err.textContent = "";\n' +
    '    status.textContent = "";\n' +
    '    var urls = [];\n' +
    '    var seen = {};\n' +
    '    document.getElementById("sourceUrls").value.split("\\n").forEach(function (line) {\n' +
    '      var u = line.trim();\n' +
    '      if (!u || seen[u]) return;\n' +
    '      seen[u] = true;\n' +
    '      urls.push(u);\n' +
    '    });\n' +
    '    if (!urls.length) { err.textContent = "Enter at least one game URL."; return; }\n' +
    '    btn.disabled = true;\n' +
    '    api("/game-imports/batch", {\n' +
    '      method: "POST",\n' +
    '      headers: { "Content-Type": "application/json" },\n' +
    '      body: JSON.stringify({ sourceUrls: urls, folderId: FOLDER_ID })\n' +
    '    }).then(function (r) {\n' +
    '      btn.disabled = false;\n' +
    '      document.getElementById("sourceUrls").value = "";\n' +
    '      status.textContent = "Started " + r.created + " new" +\n' +
    '        (r.reused ? ", skipped " + r.reused + " already existing" : "") + ".";\n' +
    '      var detail = document.getElementById("formDupList");\n' +
    '      if (detail) {\n' +
    '        if (r.duplicates && r.duplicates.length) {\n' +
    '          var dupMsg = r.duplicates.map(function (d) {\n' +
    '            return d.sourceUrl + " — in folder: " + (d.folderName ? d.folderName : "Ungrouped");\n' +
    '          }).join("\\n");\n' +
    '          detail.textContent = dupMsg;\n' +
    '          detail.hidden = false;\n' +
    '        } else {\n' +
    '          detail.textContent = "";\n' +
    '          detail.hidden = true;\n' +
    '        }\n' +
    '      }\n' +
    '      jobPage = 1;\n' +
    '      if (r.jobs && r.jobs.length) selectJob(r.jobs[0].id);\n' +
    '    }).catch(function (e) {\n' +
    '      btn.disabled = false;\n' +
    '      err.textContent = e.message;\n' +
    '    });\n' +
    '  });\n' +
    '  function openDiscoverModal(games) {\n' +
    '    var list = document.getElementById("discoverList");\n' +
    '    var html = "";\n' +
    '    games.forEach(function (g) {\n' +
    '      html += "<label class=\\"grow\\"><input type=\\"checkbox\\" data-key=\\"" + esc(g.url) + "\\" checked>" +\n' +
    '        (g.thumbnail ? "<img class=\\"thumb\\" loading=\\"lazy\\" referrerpolicy=\\"no-referrer\\" src=\\"" + esc(g.thumbnail) + "\\" alt=\\"\\">" : "<span class=\\"thumb\\"></span>") +\n' +
    '        "<span class=\\"tt\\"><b>" + esc(g.title) + "</b><small>" + esc(g.url) + "</small></span>" +\n' +
    '        (g.already ? "<span class=\\"badge\\">Added" + (g.status ? " (" + esc(g.status) + ")" : "") + "</span>" : "") +\n' +
    '        "</label>";\n' +
    '    });\n' +
    '    list.innerHTML = html;\n' +
    '    document.getElementById("discoverModal").hidden = false;\n' +
    '    updateDiscoverCount();\n' +
    '  }\n' +
    '  function closeDiscoverModal() {\n' +
    '    document.getElementById("discoverModal").hidden = true;\n' +
    '    document.getElementById("discoverList").innerHTML = "";\n' +
    '  }\n' +
    '  function updateDiscoverCount() {\n' +
    '    var n = document.getElementById("discoverList").querySelectorAll("input:checked").length;\n' +
    '    document.getElementById("discoverCount").textContent = n + " selected";\n' +
    '  }\n' +
    '  function runDiscover() {\n' +
    '    var btn = document.getElementById("discoverBtn");\n' +
    '    var err = document.getElementById("discoverError");\n' +
    '    var status = document.getElementById("discoverStatus");\n' +
    '    err.textContent = "";\n' +
    '    status.textContent = "";\n' +
    '    var url = document.getElementById("discoverUrl").value.trim();\n' +
    '    if (!url) { err.textContent = "Enter a CrazyGames listing URL (category, tag, or home page)."; return; }\n' +
    '    btn.disabled = true;\n' +
    '    api("/game-imports/discover", {\n' +
    '      method: "POST",\n' +
    '      headers: { "Content-Type": "application/json" },\n' +
    '      body: JSON.stringify({ pageUrl: url })\n' +
    '    }).then(function (r) {\n' +
    '      btn.disabled = false;\n' +
    '      if (!r.games || !r.games.length) { err.textContent = r.note || "No games found on that page."; return; }\n' +
    '      document.getElementById("discoverModalTitle").textContent = r.games.length + " games on this page";\n' +
    '      openDiscoverModal(r.games);\n' +
    '    }).catch(function (e) {\n' +
    '      btn.disabled = false;\n' +
    '      err.textContent = e.message;\n' +
    '    });\n' +
    '  }\n' +
    '  function discoverAddSelected() {\n' +
    '    var btn = document.getElementById("discoverAddBtn");\n' +
    '    var checked = Array.prototype.map.call(\n' +
    '      document.getElementById("discoverList").querySelectorAll("input:checked"),\n' +
    '      function (i) { return i.getAttribute("data-key"); }\n' +
    '    );\n' +
    '    if (!checked.length) return;\n' +
    '    btn.disabled = true;\n' +
    '    var totals = { created: 0, reused: 0, dups: [] };\n' +
    '    var next = function (i) {\n' +
    '      var chunk = checked.slice(i, i + 25);\n' +
    '      if (!chunk.length) {\n' +
    '        btn.disabled = false;\n' +
    '        closeDiscoverModal();\n' +
    '        document.getElementById("discoverStatus").textContent = "Started " + totals.created + " new" +\n' +
    '          (totals.reused ? ", skipped " + totals.reused + " already existing" : "") + ".";\n' +
    '        if (totals.dups.length) {\n' +
    '          document.getElementById("discoverError").textContent =\n' +
    '            totals.dups.length + " game(s) already imported (in folder" + (totals.dups.length > 1 ? "s" : "") + ": " +\n' +
    '            totals.dups.map(function (d) { return d.folderName ? d.folderName : "Ungrouped"; }).join(", ") + ").";\n' +
    '        }\n' +
    '        jobPage = 1;\n' +
    '        loadJobs();\n' +
    '        return;\n' +
    '      }\n' +
    '      api("/game-imports/batch", {\n' +
    '        method: "POST",\n' +
    '        headers: { "Content-Type": "application/json" },\n' +
    '        body: JSON.stringify({ sourceUrls: chunk, folderId: FOLDER_ID })\n' +
    '      }).then(function (r) {\n' +
    '        totals.created += r.created;\n' +
    '        totals.reused += r.reused;\n' +
    '        if (r.duplicates) totals.dups = totals.dups.concat(r.duplicates);\n' +
    '        next(i + 25);\n' +
    '      }, function (e) {\n' +
    '        btn.disabled = false;\n' +
    '        alert(e.message);\n' +
    '      });\n' +
    '    };\n' +
    '    next(0);\n' +
    '  }\n' +
    '  var dBtn = document.getElementById("discoverBtn");\n' +
    '  if (dBtn) dBtn.addEventListener("click", runDiscover);\n' +
    '  var modal = document.getElementById("discoverModal");\n' +
    '  if (modal) modal.addEventListener("click", function (ev) { if (ev.target === modal) closeDiscoverModal(); });\n' +
    '  var dClose = document.getElementById("discoverCloseBtn");\n' +
    '  if (dClose) dClose.addEventListener("click", closeDiscoverModal);\n' +
    '  var dList = document.getElementById("discoverList");\n' +
    '  if (dList) dList.addEventListener("change", updateDiscoverCount);\n' +
    '  var dAll = document.getElementById("discoverSelectAllBtn");\n' +
    '  if (dAll) dAll.addEventListener("click", function () {\n' +
    '    Array.prototype.forEach.call(document.getElementById("discoverList").querySelectorAll("input"), function (i) { i.checked = true; });\n' +
    '    updateDiscoverCount();\n' +
    '  });\n' +
    '  var dClear = document.getElementById("discoverClearBtn");\n' +
    '  if (dClear) dClear.addEventListener("click", function () {\n' +
    '    Array.prototype.forEach.call(document.getElementById("discoverList").querySelectorAll("input"), function (i) { i.checked = false; });\n' +
    '    updateDiscoverCount();\n' +
    '  });\n' +
    '  var dAdd = document.getElementById("discoverAddBtn");\n' +
    '  if (dAdd) dAdd.addEventListener("click", discoverAddSelected);\n' +
    '  var jPrev = document.getElementById("jobsPrevBtn");\n' +
    '  if (jPrev) jPrev.addEventListener("click", function () { gotoJobsPage(jobPage - 1); });\n' +
    '  var jNext = document.getElementById("jobsNextBtn");\n' +
    '  if (jNext) jNext.addEventListener("click", function () { gotoJobsPage(jobPage + 1); });\n' +
    '  var jSize = document.getElementById("jobsPageSize");\n' +
    '  if (jSize) jSize.addEventListener("change", function () { jobPageSize = Number(jSize.value) || 50; gotoJobsPage(1); });\n' +
    '  var fStatus = document.getElementById("filterStatus");\n' +
    '  if (fStatus) fStatus.addEventListener("change", function () {\n' +
    '    jobStatusFilter = fStatus.value;\n' +
    '    jobPage = 1;\n' +
    '    loadJobs();\n' +
    '  });\n' +
    '  var sKey = document.getElementById("sortKey");\n' +
    '  if (sKey) sKey.addEventListener("change", function () {\n' +
    '    jobSortKey = sKey.value;\n' +
    '    jobPage = 1;\n' +
    '    loadJobs();\n' +
    '  });\n' +
    '  var sDir = document.getElementById("sortDir");\n' +
    '  if (sDir) sDir.addEventListener("click", function () {\n' +
    '    jobSortDir = jobSortDir === "ASC" ? "DESC" : "ASC";\n' +
    '    sDir.lastChild.nodeValue = jobSortDir === "ASC" ? "Asc" : "Desc";\n' +
    '    jobPage = 1;\n' +
    '    loadJobs();\n' +
    '  });\n' +
    '  function initFolderTitle() {\n' +
    '    var el = document.getElementById("consoleTitle");\n' +
    '    if (!el) return;\n' +
    '    if (FOLDER_ID === "none") { el.textContent = "Ungrouped games"; return; }\n' +
    '    api("/folders/" + encodeURIComponent(FOLDER_ID)).then(function (f) {\n' +
    '      el.textContent = f.name;\n' +
    '      document.title = f.name + " — Game Import Console";\n' +
    '    }, function () {\n' +
    '      el.textContent = "Game Import Console";\n' +
    '    });\n' +
    '  }\n' +
    '  initFolderTitle();\n' +
    '  initTheme();\n' +
    '  loadJobs();\n' +
    '  renderJobsPager();\n' +
    '})();\n' +
    '</script>\n' +
    '</body>\n' +
    '</html>\n'
  );
}
