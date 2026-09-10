/**
 * Home page (dependency-free HTML, same design system as the console).
 *
 * The entry screen of the app: every game collection ("folder") is a
 * card showing live job counts. Clicking a card opens that folder's own
 * console. The copy icon between the folder icon and the name copies
 * the REAL packages path on disk, ready to paste anywhere.
 *
 * Pure string renderer, unit-testable; no game code is ever executed.
 */
export function renderHomePage(): string {
  return (
    '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="dark light">\n' +
    '<title>Game Folders — Home</title>\n' +
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
    '  --shadow-1:rgba(0,0,0,.2) 0px 3px 3px -2px,rgba(0,0,0,.14) 0px 3px 4px 0px,rgba(0,0,0,.12) 0px 1px 8px 0px;\n' +
    '  --shadow-2:rgba(0,0,0,.9) 0px 14px 40px 0px;\n' +
    '  --glow:rgba(104,66,255,.16);\n' +
    '  --glass-bg:rgba(23,25,39,.55);\n' +
    '  --glass-edge:rgba(104,66,255,.25);\n' +
    '  --glass-hi:rgba(255,255,255,.04);\n' +
    '  --ghost-bg:rgba(255,255,255,.10);\n' +
    '  --ghost-fg:#eff0f7;\n' +
    '  --ghost-hover:rgba(255,255,255,.16);\n' +
    '  --glass-shadow:0 14px 34px -20px rgba(0,0,0,.65);\n' +
    '  --ok-bg:rgba(110,231,160,.14);--ok-fg:#8ff0b8;--ok-bd:rgba(110,231,160,.35);\n' +
    '  --err-bg:rgba(255,95,109,.14);--err-fg:#ff9aa2;--err-bd:rgba(255,95,109,.4);\n' +
    '  --run-bg:rgba(104,66,255,.18);--run-fg:#cbbdff;--run-bd:rgba(104,66,255,.4);\n' +
    '}\n' +
    ':root[data-theme="light"]{\n' +
    '  color-scheme:light;\n' +
    '  --canvas:#f3f2fb;\n' +
    '  --surface:#ffffff;\n' +
    '  --surface-raised:#ecebf8;\n' +
    '  --surface-tint:rgba(40,41,61,.06);\n' +
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
    '  --ghost-bg:rgba(104,66,255,.07);\n' +
    '  --ghost-fg:#2f3148;\n' +
    '  --ghost-hover:rgba(104,66,255,.12);\n' +
    '  --shadow-1:rgba(31,34,60,.06) 0px 2px 5px -1px,rgba(31,34,60,.05) 0px 2px 8px 0px,rgba(31,34,60,.04) 0px 1px 12px 0px;\n' +
    '  --shadow-2:rgba(31,34,60,.16) 0px 14px 44px 0px;\n' +
    '  --glass-shadow:0 10px 30px -22px rgba(31,34,60,.35);\n' +
    '  --ok-bg:rgba(47,175,111,.12);--ok-fg:#157a48;--ok-bd:rgba(47,175,111,.35);\n' +
    '  --err-bg:rgba(214,58,73,.10);--err-fg:#c22a38;--err-bd:rgba(214,58,73,.35);\n' +
    '  --run-bg:rgba(104,66,255,.10);--run-fg:#5b3fd4;--run-bd:rgba(104,66,255,.35);\n' +
    '}\n' +
    'html,body{margin:0;padding:0}\n' +
    '*,*::before,*::after{box-sizing:border-box}\n' +
    'body{font-family:"Nunito","Quicksand",ui-rounded,system-ui,-apple-system,"Segoe UI",sans-serif;background:radial-gradient(1100px 420px at 50% -10%,var(--glow),transparent 62%),var(--canvas);color:var(--text);line-height:1.55;font-size:14px;min-height:100vh}\n' +
    '.appbar{display:flex;align-items:center;gap:14px;padding:14px 22px;position:sticky;top:0;z-index:5;background:var(--glass-bg);-webkit-backdrop-filter:blur(14px) saturate(150%);backdrop-filter:blur(14px) saturate(150%);border-bottom:1px solid var(--glass-edge);box-shadow:0 1px 0 var(--glass-hi) inset,var(--glass-shadow)}\n' +
    '@media (max-width:640px){.appbar{padding:12px 16px;gap:10px}.appbar p{display:none}}\n' +
    '.logo{display:grid;place-items:center;width:42px;height:42px;border-radius:22px;background:var(--brand);color:#fff;font-size:1.25rem;box-shadow:0 0 0 1px rgba(104,66,255,.4),0 8px 24px rgba(104,66,255,.35)}\n' +
    '.logo svg{width:26px;height:26px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    '.appbar h1{margin:0;font-size:1.2rem;font-weight:800}\n' +
    '.appbar p{margin:0;font-size:.85rem;color:var(--text-2);opacity:.85}\n' +
    'main{padding:22px 22px 56px}\n' +
    '.card{background:var(--surface);border:1px solid var(--divider);border-radius:var(--radius-card);box-shadow:var(--shadow-1);padding:20px;margin:16px 0}\n' +
    '.section-title{margin:0 0 14px;font-size:.75rem;font-weight:800;color:var(--brand-soft);text-transform:uppercase;letter-spacing:.12em}\n' +
    '.field{width:100%;border:1px solid var(--divider);border-radius:var(--radius-med);padding:12px 14px;font:inherit;background:var(--surface-raised);color:var(--text);resize:vertical}\n' +
    '.field:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(104,66,255,.28)}\n' +
    '.row{display:flex;gap:10px;margin-top:14px;align-items:center;flex-wrap:wrap}\n' +
    '.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:none;border-radius:var(--radius-pill);padding:10px 24px;font:inherit;font-weight:700;font-size:.9rem;cursor:pointer;transition:transform .08s,box-shadow .15s,background .15s,opacity .15s}\n' +
    '.btn:hover{transform:translateY(-1px)}\n' +
    '.btn:active{transform:translateY(0)}\n' +
    '.btn:disabled{cursor:not-allowed;opacity:.55;transform:none}\n' +
    '.btn.primary{background:var(--brand);color:var(--on-brand);box-shadow:var(--shadow-1)}\n' +
    '.btn.primary:hover{background:var(--brand-hover)}\n' +
    '.btn.ghost{background:var(--ghost-bg);color:var(--ghost-fg);box-shadow:none}\n' +
    '.btn.ghost:hover{background:var(--ghost-hover)}\n' +
    '.btn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}\n' +
    '.theme-btn{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:999px;background:var(--ghost-bg);border:1px solid var(--divider);color:var(--text-2);cursor:pointer;transition:background .15s,color .15s}\n' +
    '.theme-btn:hover{background:var(--ghost-hover);color:var(--text)}\n' +
    '.nav-tabs{display:flex;gap:8px}\n' +
    '.nav-tabs a{display:inline-flex;align-items:center;gap:6px;padding:8px 18px;border-radius:var(--radius-pill);background:var(--ghost-bg);color:var(--ghost-fg);font-weight:700;font-size:.85rem;text-decoration:none;transition:background .15s,color .15s}\n' +
    '.nav-tabs a:hover{background:var(--ghost-hover)}\n' +
    '.nav-tabs a.active{background:var(--brand);color:var(--on-brand)}\n' +
    '.nav-tabs a svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    '.theme-btn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    'code{background:var(--surface-raised);padding:2px 6px;border-radius:6px;font-family:ui-monospace,Consolas,monospace;font-size:.85em;color:var(--text-2);overflow-wrap:anywhere}\n' +
    '.err{color:var(--error);font-size:.9rem;margin-top:8px;overflow-wrap:anywhere}\n' +
    '.muted{color:var(--text-3);font-size:.85rem;overflow-wrap:anywhere}\n' +
    '.folders{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}\n' +
    '.folder{display:block;text-decoration:none;color:inherit;background:var(--surface);border:1px solid var(--divider);border-radius:var(--radius-card);box-shadow:var(--shadow-1);padding:20px;transition:transform .1s,box-shadow .15s,border-color .15s;cursor:pointer}\n' +
    '.folder:hover{transform:translateY(-2px);border-color:var(--brand);box-shadow:0 0 0 1px var(--brand),var(--shadow-1)}\n' +
    '.folder-head{display:flex;align-items:center;gap:12px}\n' +
    '.folder-ico{display:grid;place-items:center;width:52px;height:52px;border-radius:var(--radius-med);background:linear-gradient(135deg,rgba(104,66,255,.25),rgba(104,66,255,.08));color:var(--brand-soft);flex:none}\n' +
    '.folder-ico svg{width:28px;height:28px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    '.folder-name{flex:1;min-width:0;font-size:1.05rem;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n' +
    '.copy-btn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:var(--surface-raised);border:1px solid var(--divider);color:var(--text-2);cursor:pointer;transition:background .15s,color .15s,border-color .15s;flex:none}\n' +
    '.copy-btn:hover{background:var(--surface-tint);color:var(--text)}\n' +
    '.copy-btn.copied{color:var(--ok);border-color:var(--ok-bd)}\n' +
    '.copy-btn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    '.fstats{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}\n' +
    '.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:.75rem;font-weight:800;border:1px solid transparent}\n' +
    '.chip.total{background:var(--ghost-bg);color:var(--ghost-fg)}\n' +
    '.chip.run{background:var(--run-bg);color:var(--run-fg);border-color:var(--run-bd)}\n' +
    '.chip.done{background:var(--ok-bg);color:var(--ok-fg);border-color:var(--ok-bd)}\n' +
    '.chip.fail{background:var(--err-bg);color:var(--err-fg);border-color:var(--err-bd)}\n' +
    '.chip.size{background:var(--surface-raised);color:var(--text-2);border-color:var(--divider)}\n' +
    '.chip svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    '.folder-foot{margin-top:14px;display:flex;align-items:center;justify-content:space-between;gap:10px}\n' +
    '.open-hint{font-size:.8rem;color:var(--brand-soft);font-weight:700}\n' +
    '.del-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:999px;background:transparent;border:1px solid transparent;color:var(--text-3);cursor:pointer;transition:color .15s,background .15s}\n' +
    '.del-btn:hover{color:var(--error);background:rgba(255,95,109,.1)}\n' +
    '.del-btn svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    '.new-folder{border:2px dashed var(--divider);background:transparent;border-radius:var(--radius-card);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:150px;color:var(--text-3);cursor:pointer;transition:border-color .15s,color .15s,background .15s}\n' +
    '.new-folder:hover{border-color:var(--brand);color:var(--brand-soft);background:rgba(104,66,255,.05)}\n' +
    '.new-folder svg{width:32px;height:32px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    '.modal{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:20px;background:rgba(10,11,18,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}\n' +
    '.modal[hidden]{display:none}\n' +
    '.modal-panel{width:min(480px,100%);display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--divider);border-radius:var(--radius-card);box-shadow:var(--shadow-2);overflow:hidden}\n' +
    '.modal-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--divider)}\n' +
    '.modal-title{margin:0;font-size:1rem;font-weight:800;flex:1;min-width:0}\n' +
    '.modal-body{padding:18px}\n' +
    '.modal-foot{display:flex;align-items:center;gap:10px;padding:14px 18px;border-top:1px solid var(--divider)}\n' +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<header class="appbar">\n' +
    '<span class="logo"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59c-.007.052-.01.101-.017.152C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.41.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.54-.6-6.58-.68-7.26-.01-.05-.01-.1-.02-.15A4 4 0 0 0 17.32 5z"/><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/></svg></span>\n' +
    '<div>\n' +
    '<h1>Game Folders</h1>\n' +
    '<p>Organize your games into collections. Each folder has its own import console.</p>\n' +
    '</div>\n' +
    '<nav class="nav-tabs">\n' +
    '<a href="/" class="active"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>Folders</a>\n' +
    '<a href="/console/settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>Settings</a>\n' +
    '</nav>\n' +
    '<button id="themeBtn" class="theme-btn" type="button" aria-label="Toggle color theme" title="Toggle light/dark">\n' +
    '<svg id="themeIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>\n' +
    '</button>\n' +
    '</header>\n' +
    '<main>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">New folder</h2>\n' +
    '<div class="row" style="margin-top:0">\n' +
    '<input id="newFolderName" class="field" type="text" maxlength="80" placeholder="e.g. Action games, Unity picks, Favorites…">\n' +
    '<button type="button" id="newFolderBtn" class="btn primary"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>Create folder</button>\n' +
    '</div>\n' +
    '<div id="newFolderError" class="err"></div>\n' +
    '</section>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Your folders</h2>\n' +
    '<div id="foldersGrid" class="folders"><p class="muted">Loading…</p></div>\n' +
    '<div id="foldersError" class="err"></div>\n' +
    '</section>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Ungrouped games</h2>\n' +
    '<p class="muted">Jobs created outside any folder (legacy imports) live here.</p>\n' +
    '<div class="row">\n' +
    '<a href="/console/none" class="btn ghost"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Open ungrouped console</a>\n' +
    '</div>\n' +
    '</section>\n' +
    '</main>\n' +
    '<div id="nameModal" class="modal" hidden>\n' +
    '<div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="nameModalTitle">\n' +
    '<div class="modal-head"><h2 id="nameModalTitle" class="modal-title">Rename folder</h2></div>\n' +
    '<div class="modal-body">\n' +
    '<input id="renameInput" class="field" type="text" maxlength="80" placeholder="Folder name">\n' +
    '<div id="renameError" class="err"></div>\n' +
    '</div>\n' +
    '<div class="modal-foot">\n' +
    '<button id="renameSaveBtn" class="btn primary" type="button">Save</button>\n' +
    '<button id="renameCancelBtn" class="btn ghost" type="button">Cancel</button>\n' +
    '</div>\n' +
    '</div>\n' +
    '</div>\n' +
    '<script>\n' +
    '(function () {\n' +
    '  "use strict";\n' +
    '  var SUN_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><circle cx=\\"12\\" cy=\\"12\\" r=\\"5\\"/><line x1=\\"12\\" y1=\\"1\\" x2=\\"12\\" y2=\\"3\\"/><line x1=\\"12\\" y1=\\"21\\" x2=\\"12\\" y2=\\"23\\"/><line x1=\\"4.22\\" y1=\\"4.22\\" x2=\\"5.64\\" y2=\\"5.64\\"/><line x1=\\"18.36\\" y1=\\"18.36\\" x2=\\"19.78\\" y2=\\"19.78\\"/><line x1=\\"1\\" y1=\\"12\\" x2=\\"3\\" y2=\\"12\\"/><line x1=\\"21\\" y1=\\"12\\" x2=\\"23\\" y2=\\"12\\"/><line x1=\\"4.22\\" y1=\\"19.78\\" x2=\\"5.64\\" y2=\\"18.36\\"/><line x1=\\"18.36\\" y1=\\"5.64\\" x2=\\"19.78\\" y2=\\"4.22\\"/></svg>";\n' +
    '  var MOON_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z\\"/></svg>";\n' +
    '  var FOLDER_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z\\"/></svg>";\n' +
    '  var COPY_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><rect x=\\"9\\" y=\\"9\\" width=\\"13\\" height=\\"13\\" rx=\\"2\\"/><path d=\\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\\"/></svg>";\n' +
    '  var CHECK_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"M20 6L9 17l-5-5\\"/></svg>";\n' +
    '  var PLAY_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><polygon points=\\"6 3 20 12 6 21 6 3\\"/></svg>";\n' +
    '  var TRASH_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><polyline points=\\"3 6 5 6 21 6\\"/><path d=\\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\\"/></svg>";\n' +
    '  var RENAME_ID = null;\n' +
    '  function esc(s) {\n' +
    '    return String(s == null ? "" : s).replace(/[&<>"\']/g, function (c) {\n' +
    '      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\\"": "&quot;", "\\u0027": "&#39;" }[c];\n' +
    '    });\n' +
    '  }\n' +
    '  function fmtBytes(v) {\n' +
    '    var n = Number(v);\n' +
    '    if (!isFinite(n) || n < 0) return "0 B";\n' +
    '    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " GiB";\n' +
    '    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MiB";\n' +
    '    if (n >= 1024) return (n / 1024).toFixed(1) + " KiB";\n' +
    '    return n + " B";\n' +
    '  }\n' +
    '  function api(path, opts) {\n' +
    '    return fetch(path, opts).then(function (r) {\n' +
    '      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (b) {\n' +
    '        throw new Error((b && b.message) || ("Request failed: " + r.status));\n' +
    '      });\n' +
    '      return r.json();\n' +
    '    });\n' +
    '  }\n' +
    '  function copyText(text, done) {\n' +
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
    '    } else { legacy(); }\n' +
    '  }\n' +
    '  function renderFolders(folders) {\n' +
    '    var grid = document.getElementById("foldersGrid");\n' +
    '    if (!folders.length) {\n' +
    '      grid.innerHTML = "<p class=\\"muted\\">No folders yet — create your first collection above.</p>";\n' +
    '      return;\n' +
    '    }\n' +
    '    var html = "";\n' +
    '    folders.forEach(function (f) {\n' +
    '      html += "<div class=\\"folder\\" data-id=\\"" + esc(f.id) + "\\" data-root=\\"" + esc(f.packagesRoot) + "\\" title=\\"Open this folder console\\">" +\n' +
    '        "<div class=\\"folder-head\\">" +\n' +
    '        "<span class=\\"folder-ico\\">" + FOLDER_ICON + "</span>" +\n' +
    '        "<button class=\\"copy-btn\\" type=\\"button\\" data-root=\\"" + esc(f.packagesRoot) + "\\" title=\\"Copy real packages path\\" aria-label=\\"Copy packages path\\">" + COPY_ICON + "</button>" +\n' +
    '        "<span class=\\"folder-name\\">" + esc(f.name) + "</span>" +\n' +
    '        "</div>" +\n' +
    '        "<div class=\\"fstats\\">" +\n' +
    '        "<span class=\\"chip total\\">" + PLAY_ICON + esc(f.jobCounts.total) + " games</span>" +\n' +
    '        (f.jobCounts.inFlight ? "<span class=\\"chip run\\">" + f.jobCounts.inFlight + " running</span>" : "") +\n' +
    '        "<span class=\\"chip done\\">" + esc(f.jobCounts.completed) + " done</span>" +\n' +
    '        (f.jobCounts.failed ? "<span class=\\"chip fail\\">" + esc(f.jobCounts.failed) + " failed</span>" : "") +\n' +
    '        (f.storage && f.storage.packages ? "<span class=\\"chip size\\">" + fmtBytes(f.storage.bytes) + "</span>" : "") +\n' +
    '        "</div>" +\n' +
    '        "<div class=\\"folder-foot\\">" +\n' +
    '        "<span class=\\"open-hint\\">Open console →</span>" +\n' +
    '        "<button class=\\"del-btn\\" type=\\"button\\" data-id=\\"" + esc(f.id) + "\\" data-name=\\"" + esc(f.name) + "\\" title=\\"Delete this folder\\" aria-label=\\"Delete folder\\">" + TRASH_ICON + "</button>" +\n' +
    '        "</div>" +\n' +
    '        "</div>";\n' +
    '    });\n' +
    '    grid.innerHTML = html;\n' +
    '    Array.prototype.forEach.call(grid.querySelectorAll(".folder"), function (card) {\n' +
    '      card.addEventListener("click", function (ev) {\n' +
    '        if (ev.target.closest(".copy-btn") || ev.target.closest(".del-btn")) return;\n' +
    '        window.location.href = "/console/" + encodeURIComponent(card.getAttribute("data-id"));\n' +
    '      });\n' +
    '    });\n' +
    '    Array.prototype.forEach.call(grid.querySelectorAll(".copy-btn"), function (btn) {\n' +
    '      btn.addEventListener("click", function (ev) {\n' +
    '        ev.stopPropagation();\n' +
    '        var root = btn.getAttribute("data-root");\n' +
    '        copyText(root, function () {\n' +
    '          btn.innerHTML = CHECK_ICON;\n' +
    '          btn.classList.add("copied");\n' +
    '          setTimeout(function () {\n' +
    '            btn.innerHTML = COPY_ICON;\n' +
    '            btn.classList.remove("copied");\n' +
    '          }, 1500);\n' +
    '        });\n' +
    '      });\n' +
    '    });\n' +
    '    Array.prototype.forEach.call(grid.querySelectorAll(".del-btn"), function (btn) {\n' +
    '      btn.addEventListener("click", function (ev) {\n' +
    '        ev.stopPropagation();\n' +
    '        var id = btn.getAttribute("data-id");\n' +
    '        var name = btn.getAttribute("data-name");\n' +
    '        if (!window.confirm("Delete folder \\"" + name + "\\"?\\nIts games move to ungrouped (nothing is deleted from disk).")) return;\n' +
    '        api("/folders/" + encodeURIComponent(id), { method: "DELETE" }).then(load, function (e) {\n' +
    '          document.getElementById("foldersError").textContent = e.message;\n' +
    '        });\n' +
    '      });\n' +
    '    });\n' +
    '  }\n' +
    '  function load() {\n' +
    '    document.getElementById("foldersError").textContent = "";\n' +
    '    api("/folders?storage=true").then(renderFolders, function (e) {\n' +
    '      document.getElementById("foldersGrid").innerHTML = "<p class=\\"err\\">" + esc(e.message) + "</p>";\n' +
    '    });\n' +
    '  }\n' +
    '  function createFolder() {\n' +
    '    var input = document.getElementById("newFolderName");\n' +
    '    var btn = document.getElementById("newFolderBtn");\n' +
    '    var err = document.getElementById("newFolderError");\n' +
    '    err.textContent = "";\n' +
    '    var name = input.value.trim();\n' +
    '    if (!name) { err.textContent = "Enter a folder name."; return; }\n' +
    '    btn.disabled = true;\n' +
    '    api("/folders", {\n' +
    '      method: "POST",\n' +
    '      headers: { "Content-Type": "application/json" },\n' +
    '      body: JSON.stringify({ name: name })\n' +
    '    }).then(function () {\n' +
    '      btn.disabled = false;\n' +
    '      input.value = "";\n' +
    '      load();\n' +
    '    }, function (e) {\n' +
    '      btn.disabled = false;\n' +
    '      err.textContent = e.message;\n' +
    '    });\n' +
    '  }\n' +
    '  function openRename(id, name) {\n' +
    '    RENAME_ID = id;\n' +
    '    document.getElementById("renameInput").value = name;\n' +
    '    document.getElementById("renameError").textContent = "";\n' +
    '    document.getElementById("nameModal").hidden = false;\n' +
    '    document.getElementById("renameInput").focus();\n' +
    '  }\n' +
    '  function saveRename() {\n' +
    '    var name = document.getElementById("renameInput").value.trim();\n' +
    '    if (!RENAME_ID) return;\n' +
    '    if (!name) { document.getElementById("renameError").textContent = "Enter a folder name."; return; }\n' +
    '    api("/folders/" + encodeURIComponent(RENAME_ID), {\n' +
    '      method: "PATCH",\n' +
    '      headers: { "Content-Type": "application/json" },\n' +
    '      body: JSON.stringify({ name: name })\n' +
    '    }).then(function () {\n' +
    '      document.getElementById("nameModal").hidden = true;\n' +
    '      RENAME_ID = null;\n' +
    '      load();\n' +
    '    }, function (e) {\n' +
    '      document.getElementById("renameError").textContent = e.message;\n' +
    '    });\n' +
    '  }\n' +
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
    '  document.getElementById("newFolderBtn").addEventListener("click", createFolder);\n' +
    '  document.getElementById("newFolderName").addEventListener("keydown", function (ev) {\n' +
    '    if (ev.key === "Enter") createFolder();\n' +
    '  });\n' +
    '  document.getElementById("renameSaveBtn").addEventListener("click", saveRename);\n' +
    '  document.getElementById("renameCancelBtn").addEventListener("click", function () {\n' +
    '    document.getElementById("nameModal").hidden = true;\n' +
    '    RENAME_ID = null;\n' +
    '  });\n' +
    '  document.getElementById("renameInput").addEventListener("keydown", function (ev) {\n' +
    '    if (ev.key === "Enter") saveRename();\n' +
    '    if (ev.key === "Escape") { document.getElementById("nameModal").hidden = true; RENAME_ID = null; }\n' +
    '  });\n' +
    '  initTheme();\n' +
    '  load();\n' +
    '})();\n' +
    '</script>\n' +
    '</body>\n' +
    '</html>\n'
  );
}
