/**
 * Settings page (dependency-free HTML, same design system as the console).
 *
 * Renders every project-wide runtime setting grouped into cards, plus a
 * danger zone with guarded destructive actions. Each destructive action
 * opens a confirmation dialog where the operator must type the phrase
 * (DELETE) before the request is sent; the server re-checks the phrase.
 *
 * Pure string renderer, unit-testable; no game code is ever executed.
 */
export function renderSettingsPage(): string {
  return (
    '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="dark light">\n' +
    '<title>Settings — Game Import Console</title>\n' +
    '<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Crect%20width=%2724%27%20height=%2724%27%20rx=%2712%27%20fill=%27%236842ff%27/%3E%3Ccircle%20cx=%2712%27%20cy=%2712%27%20r=%273%27%20fill=%27%23fff%27/%3E%3C/svg%3E">\n' +
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
    '  --danger:#ff5f6d;\n' +
    '  --danger-hover:#ff7682;\n' +
    '  --glass-shadow:0 14px 34px -20px rgba(0,0,0,.65);\n' +
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
    '  --danger:#d63a49;\n' +
    '  --danger-hover:#e05564;\n' +
    '  --shadow-1:rgba(31,34,60,.06) 0px 2px 5px -1px,rgba(31,34,60,.05) 0px 2px 8px 0px,rgba(31,34,60,.04) 0px 1px 12px 0px;\n' +
    '  --shadow-2:rgba(31,34,60,.16) 0px 14px 44px 0px;\n' +
    '  --glass-shadow:0 10px 30px -22px rgba(31,34,60,.35);\n' +
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
    '.btn.light{background:#f9faff;color:#2f3148;box-shadow:var(--shadow-1)}\n' +
    '.btn.light:hover{background:#ffffff}\n' +
    '.btn.danger{background:var(--danger);color:#fff;box-shadow:var(--shadow-1)}\n' +
    '.btn.danger:hover{background:var(--danger-hover)}\n' +
    '.btn.danger:disabled{background:var(--danger)}\n' +
    '.theme-btn{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:999px;background:var(--ghost-bg);border:1px solid var(--divider);color:var(--text-2);cursor:pointer;transition:background .15s,color .15s}\n' +
    '.theme-btn:hover{background:var(--ghost-hover);color:var(--text)}\n' +
    '.theme-btn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    'code{background:var(--surface-raised);padding:2px 6px;border-radius:6px;font-family:ui-monospace,Consolas,monospace;font-size:.85em;color:var(--text-2);overflow-wrap:anywhere}\n' +
    '.err{color:var(--error);font-size:.9rem;margin-top:8px;overflow-wrap:anywhere}\n' +
    '.ok{color:var(--ok)}\n' +
    '.muted{color:var(--text-3);font-size:.85rem;overflow-wrap:anywhere}\n' +
    '.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 16px;font-size:.9rem}\n' +
    '.kv b{color:var(--brand-soft);font-weight:800;font-size:.74rem;text-transform:uppercase;letter-spacing:.08em;padding-top:3px}\n' +
    '.kv>span{min-width:0;overflow-wrap:anywhere;color:var(--text-2)}\n' +
    '.kv span.on{color:var(--ok);font-weight:700}\n' +
    '.kv span.off{color:var(--text-3)}\n' +
    '.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}\n' +
    '.stat{background:var(--surface-raised);border:1px solid var(--divider);border-radius:var(--radius-med);padding:14px 16px;text-align:center}\n' +
    '.stat b{display:block;font-size:1.6rem;color:var(--text)}\n' +
    '.stat small{color:var(--text-3);font-size:.74rem;text-transform:uppercase;letter-spacing:.08em}\n' +
    '.dz-item{border:1px solid var(--divider);border-radius:var(--radius-med);padding:14px 16px;margin-top:12px;display:flex;gap:14px;align-items:flex-start;background:var(--surface-raised)}\n' +
    '.dz-item .tt{flex:1;min-width:0}\n' +
    '.dz-item .tt b{display:block;color:var(--text)}\n' +
    '.dz-item .tt small{display:block;color:var(--text-3);font-size:.78rem;margin-top:2px}\n' +
    '.dz-item .btn{flex:none}\n' +
    '.nav-tabs{display:flex;gap:8px}\n' +
    '.nav-tabs a{display:inline-flex;align-items:center;gap:6px;padding:8px 18px;border-radius:var(--radius-pill);background:var(--ghost-bg);color:var(--ghost-fg);font-weight:700;font-size:.85rem;text-decoration:none;transition:background .15s,color .15s}\n' +
    '.nav-tabs a:hover{background:var(--ghost-hover)}\n' +
    '.nav-tabs a.active{background:var(--brand);color:var(--on-brand)}\n' +
    '.nav-tabs a svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\n' +
    '.modal{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:20px;background:rgba(10,11,18,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}\n' +
    '.modal[hidden]{display:none}\n' +
    '.modal-panel{width:min(520px,100%);display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--divider);border-radius:var(--radius-card);box-shadow:var(--shadow-2);overflow:hidden}\n' +
    '.modal-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--divider)}\n' +
    '.modal-title{margin:0;font-size:1rem;font-weight:800;flex:1;min-width:0}\n' +
    '.modal-body{padding:18px}\n' +
    '.modal-foot{display:flex;align-items:center;gap:10px;padding:14px 18px;border-top:1px solid var(--divider);flex-wrap:wrap}\n' +
    '.modal-foot .muted{margin-left:auto}\n' +
    '.modal-body .field{margin-top:10px}\n' +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<header class="appbar">\n' +
    '<span class="logo"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59c-.007.052-.01.101-.017.152C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.41.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.54-.6-6.58-.68-7.26-.01-.05-.01-.1-.02-.15A4 4 0 0 0 17.32 5z"/><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/></svg></span>\n' +
    '<div>\n' +
    '<h1>Settings</h1>\n' +
    '<p>Project runtime settings (environment-driven) and maintenance actions.</p>\n' +
    '</div>\n' +
    '<nav class="nav-tabs">\n' +
    '<a href="/console"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>Console</a>\n' +
    '<a href="/console/settings" class="active"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>Settings</a>\n' +
    '</nav>\n' +
    '<button id="themeBtn" class="theme-btn" type="button" aria-label="Toggle color theme" title="Toggle light/dark">\n' +
    '<svg id="themeIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>\n' +
    '</button>\n' +
    '</header>\n' +
    '<main>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Overview</h2>\n' +
    '<p class="muted">Settings are read from the server environment (e.g. <code>.env</code>). Changing a value means editing it there and restarting the server — this page documents the live values and provides maintenance actions.</p>\n' +
    '<div id="stats" class="stats" style="margin-top:14px"></div>\n' +
    '<div class="row">\n' +
    '<button id="reloadBtn" class="btn ghost" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Refresh</button>\n' +
    '<span id="statusMsg" class="muted"></span>\n' +
    '</div>\n' +
    '</section>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Server</h2>\n' +
    '<div class="kv" id="kvServer"></div>\n' +
    '</section>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Database</h2>\n' +
    '<div class="kv" id="kvDatabase"></div>\n' +
    '</section>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Queue</h2>\n' +
    '<div class="kv" id="kvQueue"></div>\n' +
    '</section>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Import limits</h2>\n' +
    '<div class="kv" id="kvLimits"></div>\n' +
    '</section>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Storage &amp; paths</h2>\n' +
    '<div class="kv" id="kvPaths"></div>\n' +
    '</section>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Security</h2>\n' +
    '<div class="kv" id="kvSecurity"></div>\n' +
    '</section>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Runtime &amp; Unity</h2>\n' +
    '<div class="kv" id="kvRuntime"></div>\n' +
    '</section>\n' +
    '<section class="card">\n' +
    '<h2 class="section-title">Danger zone</h2>\n' +
    '<p class="muted">Every action is irreversible and asks for confirmation (type <code>DELETE</code>). In-flight imports may fail when their data is removed.</p>\n' +
    '<div class="dz-item">\n' +
    '<div class="tt"><b>Delete all jobs</b><small>Removes every job row from the database (stats, logs, diagnostics). Stored packages and work dirs are kept.</small></div>\n' +
    '<button id="clearJobsBtn" class="btn danger" type="button">Delete jobs</button>\n' +
    '</div>\n' +
    '<div class="dz-item">\n' +
    '<div class="tt"><b>Clear work directories</b><small>Deletes every temporary import directory under the work dir. In-flight imports may fail.</small></div>\n' +
    '<button id="clearWorkBtn" class="btn danger" type="button">Clear work</button>\n' +
    '</div>\n' +
    '<div class="dz-item">\n' +
    '<div class="tt"><b>Delete all packages</b><small>Deletes every stored, runnable game package. Jobs rows stay, but their local run button will stop working.</small></div>\n' +
    '<button id="clearPackagesBtn" class="btn danger" type="button">Delete packages</button>\n' +
    '</div>\n' +
    '<div class="dz-item">\n' +
    '<div class="tt"><b>Reset everything</b><small>Jobs + work dirs + packages: the full wipe. Fresh state, as if nothing was ever imported.</small></div>\n' +
    '<button id="resetAllBtn" class="btn danger" type="button">Reset all</button>\n' +
    '</div>\n' +
    '<div id="dzError" class="err"></div>\n' +
    '</section>\n' +
    '</main>\n' +
    '<div id="confirmModal" class="modal" hidden>\n' +
    '<div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">\n' +
    '<div class="modal-head"><h2 id="confirmTitle" class="modal-title">Confirm</h2>\n' +
    '<button id="confirmCloseBtn" class="btn ghost" style="padding:6px 10px" type="button" aria-label="Close dialog">✕</button>\n' +
    '</div>\n' +
    '<div class="modal-body">\n' +
    '<p id="confirmText" style="margin:0"></p>\n' +
    '<input id="confirmInput" class="field" type="text" placeholder="Type DELETE to confirm" autocomplete="off" spellcheck="false">\n' +
    '</div>\n' +
    '<div class="modal-foot">\n' +
    '<button id="confirmYesBtn" class="btn danger" type="button" disabled>Yes, do it</button>\n' +
    '<span class="muted">This cannot be undone.</span>\n' +
    '</div>\n' +
    '</div>\n' +
    '</div>\n' +
    '<script>\n' +
    '(function () {\n' +
    '  "use strict";\n' +
    '  var SUN_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><circle cx=\\"12\\" cy=\\"12\\" r=\\"5\\"/><line x1=\\"12\\" y1=\\"1\\" x2=\\"12\\" y2=\\"3\\"/><line x1=\\"12\\" y1=\\"21\\" x2=\\"12\\" y2=\\"23\\"/><line x1=\\"4.22\\" y1=\\"4.22\\" x2=\\"5.64\\" y2=\\"5.64\\"/><line x1=\\"18.36\\" y1=\\"18.36\\" x2=\\"19.78\\" y2=\\"19.78\\"/><line x1=\\"1\\" y1=\\"12\\" x2=\\"3\\" y2=\\"12\\"/><line x1=\\"21\\" y1=\\"12\\" x2=\\"23\\" y2=\\"12\\"/><line x1=\\"4.22\\" y1=\\"19.78\\" x2=\\"5.64\\" y2=\\"18.36\\"/><line x1=\\"18.36\\" y1=\\"5.64\\" x2=\\"19.78\\" y2=\\"4.22\\"/></svg>";\n' +
    '  var MOON_ICON = "<svg viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\"><path d=\\"M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z\\"/></svg>";\n' +
    '  var PENDING_ACTION = null;\n' +
    '  function esc(s) {\n' +
    '    return String(s == null ? "" : s).replace(/[&<>"\']/g, function (c) {\n' +
    '      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\\"": "&quot;", "\\u0027": "&#39;" }[c];\n' +
    '    });\n' +
    '  }\n' +
    '  function fmtBytes(v) {\n' +
    '    var n = Number(v);\n' +
    '    if (!isFinite(n)) return esc(v);\n' +
    '    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " GiB";\n' +
    '    if (n >= 1048576) return (n / 1048576).toFixed(0) + " MiB";\n' +
    '    if (n >= 1024) return (n / 1024).toFixed(0) + " KiB";\n' +
    '    return n + " B";\n' +
    '  }\n' +
    '  function fmtMs(v) {\n' +
    '    var n = Number(v);\n' +
    '    if (!isFinite(n)) return esc(v);\n' +
    '    if (n >= 60000) return (n / 60000).toFixed(0) + " min";\n' +
    '    return (n / 1000).toFixed(0) + " s";\n' +
    '  }\n' +
    '  function api(path, opts) {\n' +
    '    return fetch(path, opts).then(function (r) {\n' +
    '      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (b) {\n' +
    '        throw new Error((b && b.message) || ("Request failed: " + r.status));\n' +
    '      });\n' +
    '      return r.json();\n' +
    '    });\n' +
    '  }\n' +
    '  function kvRow(k, v, cls) {\n' +
    '    return "<b>" + esc(k) + "</b><span" + (cls ? " class=\\"" + cls + "\\"" : "") + ">" + v + "</span>";\n' +
    '  }\n' +
    '  function boolCell(b) { return b ? "on" : "off"; }\n' +
    '  function boolText(b) { return b ? "enabled" : "disabled"; }\n' +
    '  function render(s) {\n' +
    '    document.getElementById("stats").innerHTML =\n' +
    '      "<div class=\\"stat\\"><b>" + esc(s.stats.jobs) + "</b><small>Jobs</small></div>" +\n' +
    '      "<div class=\\"stat\\"><b>" + esc(s.stats.packages) + "</b><small>Packages · " + fmtBytes(s.stats.packagesBytes || 0) + "</small></div>" +\n' +
    '      "<div class=\\"stat\\"><b>" + esc(s.stats.workDirs) + "</b><small>Work dirs · " + fmtBytes(s.stats.workBytes || 0) + "</small></div>";\n' +
    '    document.getElementById("kvServer").innerHTML =\n' +
    '      kvRow("Port", esc(s.server.port)) +\n' +
    '      kvRow("Python executable", "<code>" + esc(s.runtime.python) + "</code>");\n' +
    '    document.getElementById("kvDatabase").innerHTML =\n' +
    '      kvRow("Driver", esc(s.database.driver)) +\n' +
    '      kvRow("SQLite path", esc(s.database.sqlitePath));\n' +
    '    document.getElementById("kvQueue").innerHTML =\n' +
    '      kvRow("Driver", esc(s.queue.driver)) +\n' +
    '      kvRow("Redis URL set", boolText(s.queue.redisUrl), boolCell(s.queue.redisUrl)) +\n' +
    '      kvRow("Concurrency", esc(s.queue.concurrency)) +\n' +
    '      kvRow("Job timeout", fmtMs(s.queue.jobTimeoutMs));\n' +
    '    document.getElementById("kvLimits").innerHTML =\n' +
    '      kvRow("Max download", fmtBytes(s.limits.maxDownloadBytes)) +\n' +
    '      kvRow("Max extracted", fmtBytes(s.limits.maxExtractedBytes)) +\n' +
    '      kvRow("Worker timeout", fmtMs(s.limits.workerTimeoutMs)) +\n' +
    '      kvRow("Worker max memory", esc(s.limits.workerMaxMemoryMb) + " MiB") +\n' +
    '      kvRow("Worker max disk", esc(s.limits.workerMaxDiskMb) + " MiB");\n' +
    '    document.getElementById("kvPaths").innerHTML =\n' +
    '      kvRow("Storage driver", esc(s.paths.storageDriver)) +\n' +
    '      kvRow("Storage root", "<code>" + esc(s.paths.storageRoot) + "</code>") +\n' +
    '      kvRow("Work dir", "<code>" + esc(s.paths.workDir) + "</code>");\n' +
    '    document.getElementById("kvSecurity").innerHTML =\n' +
    '      kvRow("Allowed hosts", s.security.allowedHosts.length ? s.security.allowedHosts.map(function (h) { return "<code>" + esc(h) + "</code>"; }).join(" ") : "<span class=\\"off\\">none</span>") +\n' +
    '      kvRow("Allow any HTTPS", boolText(s.security.allowAnyHttps), s.security.allowAnyHttps ? "on" : "off") +\n' +
    '      kvRow("Block private networks", boolText(s.security.blockPrivateNetworks), boolCell(s.security.blockPrivateNetworks)) +\n' +
    '      kvRow("Block cloud metadata", boolText(s.security.cloudMetadataBlock), boolCell(s.security.cloudMetadataBlock));\n' +
    '    document.getElementById("kvRuntime").innerHTML =\n' +
    '      kvRow("Validation timeout", fmtMs(s.runtime.validationTimeoutMs)) +\n' +
    '      kvRow("Playwright executable", s.runtime.playwrightExecutablePath ? "<code>" + esc(s.runtime.playwrightExecutablePath) + "</code>" : "default (Playwright cache)") +\n' +
    '      kvRow("Streaming-assets runtime discovery", boolText(s.runtime.streamingAssetsRuntimeDiscovery), boolCell(s.runtime.streamingAssetsRuntimeDiscovery)) +\n' +
    '      kvRow("Streaming-assets local discovery", boolText(s.runtime.streamingAssetsLocalDiscovery), boolCell(s.runtime.streamingAssetsLocalDiscovery)) +\n' +
    '      kvRow("Python executable", "<code>" + esc(s.runtime.python) + "</code>");\n' +
    '  }\n' +
    '  function load() {\n' +
    '    document.getElementById("statusMsg").textContent = "Loading…";\n' +
    '    api("/game-imports/settings").then(function (s) {\n' +
    '      document.getElementById("statusMsg").textContent = "";\n' +
    '      render(s);\n' +
    '    }, function (e) {\n' +
    '      document.getElementById("statusMsg").textContent = "";\n' +
    '      document.getElementById("dzError").textContent = e.message;\n' +
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
    '  var ACTIONS = {\n' +
    '    clearJobs: { title: "Delete all jobs?", text: "Every job row (stats, logs, diagnostics) will be removed from the database. Stored packages and work dirs are kept.", endpoint: "/game-imports/settings/clear-jobs", done: "Deleted #jobs jobs." },\n' +
    '    clearWork: { title: "Clear all work dirs?", text: "Every temporary import directory under the work dir will be deleted. In-flight imports may fail.", endpoint: "/game-imports/settings/clear-work", done: "Cleared #workDirs work dirs." },\n' +
    '    clearPackages: { title: "Delete all packages?", text: "Every stored runnable game package will be deleted. Job rows stay, but their local run button stops working.", endpoint: "/game-imports/settings/clear-packages", done: "Deleted #packages packages." },\n' +
    '    resetAll: { title: "Reset everything?", text: "ALL jobs + work dirs + packages will be permanently deleted. The app returns to a fresh state.", endpoint: "/game-imports/settings/reset-all", done: "Reset: #jobs jobs, #workDirs work dirs, #packages packages." }\n' +
    '  };\n' +
    '  function openConfirm(key) {\n' +
    '    PENDING_ACTION = ACTIONS[key];\n' +
    '    document.getElementById("confirmTitle").textContent = PENDING_ACTION.title;\n' +
    '    document.getElementById("confirmText").textContent = PENDING_ACTION.text;\n' +
    '    document.getElementById("confirmInput").value = "";\n' +
    '    document.getElementById("confirmYesBtn").disabled = true;\n' +
    '    document.getElementById("dzError").textContent = "";\n' +
    '    document.getElementById("confirmModal").hidden = false;\n' +
    '    document.getElementById("confirmInput").focus();\n' +
    '  }\n' +
    '  function closeConfirm() {\n' +
    '    document.getElementById("confirmModal").hidden = true;\n' +
    '    PENDING_ACTION = null;\n' +
    '  }\n' +
    '  function runAction() {\n' +
    '    var btn = document.getElementById("confirmYesBtn");\n' +
    '    var phrase = document.getElementById("confirmInput").value;\n' +
    '    if (!PENDING_ACTION) return;\n' +
    '    btn.disabled = true;\n' +
    '    api(PENDING_ACTION.endpoint, {\n' +
    '      method: "POST",\n' +
    '      headers: { "Content-Type": "application/json" },\n' +
    '      body: JSON.stringify({ confirm: phrase })\n' +
    '    }).then(function (r) {\n' +
    '      var msg = PENDING_ACTION.done\n' +
    '        .replace("#jobs", r.clearedJobs != null ? r.clearedJobs : (r.cleared != null ? r.cleared : "?"))\n' +
    '        .replace("#workDirs", r.clearedWork != null ? r.clearedWork : (r.cleared != null ? r.cleared : "?"))\n' +
    '        .replace("#packages", r.clearedPackages != null ? r.clearedPackages : (r.cleared != null ? r.cleared : "?"));\n' +
    '      closeConfirm();\n' +
    '      document.getElementById("statusMsg").textContent = msg;\n' +
    '      load();\n' +
    '    }, function (e) {\n' +
    '      btn.disabled = false;\n' +
    '      document.getElementById("dzError").textContent = e.message;\n' +
    '    });\n' +
    '  }\n' +
    '  document.getElementById("clearJobsBtn").addEventListener("click", function () { openConfirm("clearJobs"); });\n' +
    '  document.getElementById("clearWorkBtn").addEventListener("click", function () { openConfirm("clearWork"); });\n' +
    '  document.getElementById("clearPackagesBtn").addEventListener("click", function () { openConfirm("clearPackages"); });\n' +
    '  document.getElementById("resetAllBtn").addEventListener("click", function () { openConfirm("resetAll"); });\n' +
    '  document.getElementById("confirmCloseBtn").addEventListener("click", closeConfirm);\n' +
    '  var modal = document.getElementById("confirmModal");\n' +
    '  modal.addEventListener("click", function (ev) { if (ev.target === modal) closeConfirm(); });\n' +
    '  document.getElementById("confirmInput").addEventListener("input", function () {\n' +
    '    document.getElementById("confirmYesBtn").disabled = this.value.trim().toUpperCase() !== "DELETE";\n' +
    '  });\n' +
    '  document.getElementById("confirmInput").addEventListener("keydown", function (ev) {\n' +
    '    if (ev.key === "Enter" && !document.getElementById("confirmYesBtn").disabled) runAction();\n' +
    '    if (ev.key === "Escape") closeConfirm();\n' +
    '  });\n' +
    '  document.getElementById("confirmYesBtn").addEventListener("click", runAction);\n' +
    '  document.getElementById("reloadBtn").addEventListener("click", load);\n' +
    '  initTheme();\n' +
    '  load();\n' +
    '})();\n' +
    '</script>\n' +
    '</body>\n' +
    '</html>\n'
  );
}
