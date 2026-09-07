/**
 * Management console page (M3.2 DX).
 *
 * A single dependency-free HTML document served at `GET /console`. It calls
 * only the existing public import API (`POST /game-imports`, `GET
 * /game-imports`, `GET /game-imports/:id`, `POST …/cancel`, `GET …/logs`)
 * from same-origin browser JavaScript. Pure string renderer so the markup
 * is unit-testable; no game code is ever executed here (imported games run
 * only in the isolated Playwright sandbox / operator-served packages).
 */
export function renderConsolePage(): string {
  return (
    '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>Game Import Console</title>\n' +
    '<style>\n' +
    ':root{color-scheme:light dark}\n' +
    'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0 auto;max-width:960px;padding:16px}\n' +
    'h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:24px}\n' +
    'form{display:flex;gap:8px;margin:12px 0}\n' +
    'input[type=url]{flex:1;padding:8px;font-size:1rem}\n' +
    'button{padding:8px 14px;font-size:1rem;cursor:pointer}\n' +
    'button:disabled{cursor:wait;opacity:.6}\n' +
    '.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.85rem;font-weight:600}\n' +
    '.queued,.detecting,.resolving,.downloading,.extracting,.validating,.uploading{background:#e3f0ff}\n' +
    '.completed{background:#dcf5e3}.failed{background:#fbdcdc}.cancelled{background:#eee}\n' +
    '.bar{height:10px;background:#ddd;border-radius:5px;overflow:hidden;margin:8px 0}\n' +
    '.bar>i{display:block;height:100%;background:#2f7cf6}\n' +
    'table{border-collapse:collapse;width:100%;font-size:.9rem}\n' +
    'td,th{border-bottom:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}\n' +
    'tr.job{cursor:pointer}tr.job:hover{background:#f0f6ff}tr.job.sel{background:#e3f0ff}\n' +
    'pre{background:#111;color:#ddd;padding:10px;overflow:auto;max-height:220px;font-size:.8rem}\n' +
    '.err{color:#b00020}.warn{color:#8a5a00}.ok{color:#0a7a2e}\n' +
    'code{background:#eee;padding:1px 5px;border-radius:4px}\n' +
    '.muted{color:#666;font-size:.85rem}\n' +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<h1>🎮 Game Import Console</h1>\n' +
    '<p class="muted">Import authorized HTML5/Unity games, watch progress, inspect diagnostics, and get local run instructions.</p>\n' +
    '<form id="startForm">\n' +
    '<input type="url" id="sourceUrl" required placeholder="https://www.crazygames.com/game/…" size="60">\n' +
    '<button type="submit" id="startBtn">Start import</button>\n' +
    '</form>\n' +
    '<div id="formError" class="err"></div>\n' +
    '<h2>Jobs</h2>\n' +
    '<table><thead><tr><th>ID</th><th>Source</th><th>Status</th><th>Progress</th><th>Updated</th></tr></thead>\n' +
    '<tbody id="jobRows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table>\n' +
    '<h2>Details</h2>\n' +
    '<div id="detail" class="muted">Select a job to inspect it.</div>\n' +
    '<script>\n' +
    '(function () {\n' +
    '  "use strict";\n' +
    '  var selectedId = null;\n' +
    '  var activeTimer = null;\n' +
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
    '  function loadJobs() {\n' +
    '    api("/game-imports?limit=50").then(function (jobs) {\n' +
    '      var tb = document.getElementById("jobRows");\n' +
    '      if (!jobs.length) { tb.innerHTML = "<tr><td colspan=\\"5\\" class=\\"muted\\">No jobs yet.</td></tr>"; return; }\n' +
    '      var html = "";\n' +
    '      jobs.forEach(function (j) {\n' +
    '        html += "<tr class=\\"job" + (j.id === selectedId ? " sel" : "") + "\\" data-id=\\"" + esc(j.id) + "\\">" +\n' +
    '          "<td><code>" + shortId(j.id) + "</code></td>" +\n' +
    '          "<td>" + esc(j.sourceUrl) + "</td>" +\n' +
    '          "<td><span class=\\"pill " + esc(j.status) + "\\">" + esc(j.status) + "</span></td>" +\n' +
    '          "<td>" + esc(j.progress) + "%</td>" +\n' +
    '          "<td class=\\"muted\\">" + esc(j.updatedAt) + "</td></tr>";\n' +
    '      });\n' +
    '      tb.innerHTML = html;\n' +
    '      Array.prototype.forEach.call(tb.querySelectorAll("tr.job"), function (tr) {\n' +
    '        tr.addEventListener("click", function () { selectJob(tr.getAttribute("data-id")); });\n' +
    '      });\n' +
    '    }).catch(function (e) {\n' +
    '      document.getElementById("jobRows").innerHTML = "<tr><td colspan=\\"5\\" class=\\"err\\">" + esc(e.message) + "</td></tr>";\n' +
    '    });\n' +
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
    '  function runHelp(pkgPath) {\n' +
    '    if (!pkgPath) return "";\n' +
    '    return "<h3>Run locally</h3>" +\n' +
    '      "<pre>cd \\"" + pkgPath.replace(/\\"/g, "") + "\\"" +\n' +
    '      "\\npython -m http.server 8080</pre>" +\n' +
    '      "<p>Open <code>http://localhost:8080</code> — serve over HTTP, never <code>file://</code> (Unity WebGL requires HTTP). " +\n' +
    '      "Then check DevTools Console/Network for failed game assets.</p>";\n' +
    '  }\n' +
    '  function renderDetail(j, logs) {\n' +
    '    var el = document.getElementById("detail");\n' +
    '    var html = "<p><span class=\\"pill " + esc(j.status) + "\\">" + esc(j.status) + "</span> " +\n' +
    '      "<code>" + esc(j.id) + "</code></p>" +\n' +
    '      "<p><strong>Source:</strong> " + esc(j.sourceUrl) + "<br>" +\n' +
    '      "<strong>Step:</strong> " + esc(j.currentStep) + " &nbsp; <strong>Engine:</strong> " + esc(j.detectedEngine || "—") + "<br>" +\n' +
    '      "<strong>Files:</strong> " + esc(j.downloadedFiles) + " / " + esc(j.totalFiles) + "</p>" +\n' +
    '      "<div class=\\"bar\\"><i style=\\"width:" + esc(j.progress) + "%\\"></i></div>";\n' +
    '    if (j.status === "failed") {\n' +
    '      html += "<p class=\\"err\\"><strong>Failed" + (j.errorCode ? " (" + esc(j.errorCode) + ")" : "") + ":</strong> " + esc(j.error) + "</p>";\n' +
    '      if (j.packageUrl) html += "<p><strong>Partial package:</strong> <code>" + esc(j.packageUrl) + "</code></p>";\n' +
    '    }\n' +
    '    if (j.status === "completed") {\n' +
    '      html += "<p class=\\"ok\\"><strong>Package:</strong> <code>" + esc(j.packageUrl) + "</code></p>" + runHelp(j.packageUrl);\n' +
    '    }\n' +
    '    if (["queued", "detecting", "resolving", "downloading", "extracting", "validating", "uploading"].indexOf(j.status) >= 0) {\n' +
    '      html += "<p><button id=\\"cancelBtn\\">Cancel job</button></p>";\n' +
    '    }\n' +
    '    html += "<h3>Diagnostics</h3>" + diagList(j.diagnostics);\n' +
    '    html += "<h3>Logs</h3><pre>" + esc((logs || []).map(function (l) { return l.at + " [" + l.level + "] " + l.message; }).join("\\n")) + "</pre>";\n' +
    '    el.innerHTML = html;\n' +
    '    el.classList.remove("muted");\n' +
    '    var cb = document.getElementById("cancelBtn");\n' +
    '    if (cb) cb.addEventListener("click", function () {\n' +
    '      cb.disabled = true;\n' +
    '      api("/game-imports/" + encodeURIComponent(j.id) + "/cancel", { method: "POST" }).then(refreshSelected, function (e) {\n' +
    '        cb.disabled = false; alert(e.message);\n' +
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
    '    err.textContent = "";\n' +
    '    var url = document.getElementById("sourceUrl").value.trim();\n' +
    '    if (!url) { err.textContent = "Enter a game URL first."; return; }\n' +
    '    btn.disabled = true;\n' +
    '    api("/game-imports", {\n' +
    '      method: "POST",\n' +
    '      headers: { "Content-Type": "application/json" },\n' +
    '      body: JSON.stringify({ sourceUrl: url })\n' +
    '    }).then(function (j) {\n' +
    '      btn.disabled = false;\n' +
    '      document.getElementById("sourceUrl").value = "";\n' +
    '      selectJob(j.id);\n' +
    '    }).catch(function (e) {\n' +
    '      btn.disabled = false;\n' +
    '      err.textContent = e.message;\n' +
    '    });\n' +
    '  });\n' +
    '  loadJobs();\n' +
    '  setInterval(loadJobs, 5000);\n' +
    '})();\n' +
    '</script>\n' +
    '</body>\n' +
    '</html>\n'
  );
}
