'use strict';
/*
 * AI Loop dashboard server — zero dependencies, plain Node.js.
 * Serves dashboard.html + a small JSON API that manages the PowerShell loop
 * (scripts/ai-loop/run-all.ps1) as a single background child process.
 *
 * Binds 127.0.0.1 ONLY (local operator use, same trust boundary as the app).
 *
 * Usage:
 *   node scripts/ai-loop/server.js [--port 8090]
 *   npm run loop:ui
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, exec } = require('node:child_process');

const AI_LOOP_DIR = __dirname;
const LOG_DIR = path.join(AI_LOOP_DIR, 'logs');
const RUN_ALL = path.join(AI_LOOP_DIR, 'run-all.ps1');
const DASHBOARD = path.join(AI_LOOP_DIR, 'dashboard.html');

const PORT = parseInt(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : (process.env.AI_LOOP_UI_PORT || '8090'), 10) || 8090;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Single loop process at a time.
let child = null;
let runInfo = null; // { pid, root, startedAt, args }

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function safeBasename(name) {
  const b = path.basename(String(name || ''));
  return (b && b !== '.' && b !== '..') ? b : null;
}

function listLogFiles() {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log') || f.endsWith('.csv') || f.endsWith('.md'))
      .map((f) => {
        const st = fs.statSync(path.join(LOG_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

function readState() {
  const p = path.join(LOG_DIR, 'state.json');
  try {
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function listFolders(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// PowerShell 5.1 `>` redirection writes UTF-16LE, Set-Content writes UTF-8
// (often with BOM), opencode itself emits UTF-8. Detect and decode correctly
// so Arabic/log text never shows as mojibake.
function readLogText(fp, maxTailBytes) {
  let buf = fs.readFileSync(fp);
  if (maxTailBytes && buf.length > maxTailBytes) buf = buf.slice(buf.length - maxTailBytes);
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '');
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return Buffer.from(buf).swap16().toString('utf16le').replace(/^\uFEFF/, '');
  }
  let s = buf.toString('utf8');
  if (s.indexOf('\0') !== -1) s = buf.toString('utf16le');
  return s.replace(/^\uFEFF/, '');
}

function tailFile(filePath, n) {
  const raw = readLogText(filePath, 512 * 1024);
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function readLastNonEmptyLine(fp) {
  try {
    const lines = readLogText(fp, 32768).replace(/\r\n/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1].slice(0, 500) : '';
  } catch { return ''; }
}

// Detect an opencode process started OUTSIDE this UI (e.g. loop launched
// from a PowerShell terminal), so the dashboard still shows live tracking.
function externalLoopRunning() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? 'tasklist /FI "IMAGENAME eq opencode.exe" /NH'
      : 'pgrep -f "opencode run"';
    exec(cmd, { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(/opencode/i.test(stdout || ''));
    });
  });
}

function killLoop() {
  return new Promise((resolve) => {
    if (!child) return resolve(false);
    const pid = child.pid;
    const done = () => { child = null; runInfo = null; resolve(true); };
    child.on('exit', done);
    if (process.platform === 'win32') {
      exec(`taskkill /PID ${pid} /T /F`, () => { setTimeout(() => { child = null; runInfo = null; resolve(true); }, 500); });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
      setTimeout(() => { child = null; runInfo = null; resolve(true); }, 1000);
    }
    setTimeout(done, 4000);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(DASHBOARD).pipe(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/folders') {
      const root = url.searchParams.get('root') || '';
      if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        return sendJson(res, 400, { error: 'Root not found or not a directory' });
      }
      return sendJson(res, 200, { folders: listFolders(root) });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const root = url.searchParams.get('root') || '';
      let folders = [];
      if (root && fs.existsSync(root)) {
        try { folders = listFolders(root); } catch { folders = []; }
      }
      const state = readState();
      const logs = listLogFiles();
      const gameLogs = logs.filter((l) => l.name.endsWith('.log'));
      let latestActivity = null;
      if (gameLogs.length) {
        const newest = gameLogs[0];
        latestActivity = {
          file: newest.name,
          line: readLastNonEmptyLine(path.join(LOG_DIR, newest.name)),
          mtime: newest.mtime,
        };
      }
      const managed = !!(child && child.exitCode === null);
      const externalRunning = managed ? false : await externalLoopRunning();
      const running = managed || externalRunning;
      return sendJson(res, 200, {
        running,
        managed,
        externalRunning,
        runInfo,
        latestActivity,
        folders: folders.map((f) => ({ ...f, ...(state[f.name] ? { status: state[f.name].status, exitCode: state[f.name].exitCode, log: state[f.name].log } : { status: 'pending' }) })),
        logs: logs.slice(0, 60),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/log') {
      const name = safeBasename(url.searchParams.get('file'));
      const tail = Math.min(parseInt(url.searchParams.get('tail') || '200', 10) || 200, 2000);
      if (!name) return sendJson(res, 400, { error: 'bad file' });
      const fp = path.join(LOG_DIR, name);
      if (!fp.startsWith(LOG_DIR) || !fs.existsSync(fp)) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, { name, content: tailFile(fp, tail) });
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      if (child && child.exitCode === null) return sendJson(res, 409, { error: 'loop already running', pid: child.pid });
      const body = await readBody(req);
      const root = String(body.root || '');
      if (!root || !fs.existsSync(root)) return sendJson(res, 400, { error: 'Root not found' });

      const port = parseInt(body.port || '8080', 10) || 8080;
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RUN_ALL, '-Root', root, '-Port', String(port)];
      if (body.autoApprove) args.push('-AutoApprove');
      if (body.redoFailed) args.push('-RedoFailed');
      if (body.cleanupBetween) args.push('-CleanupBetween');
      if (body.model) args.push('-Model', String(body.model));
      if (body.agent) args.push('-Agent', String(body.agent));
      const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (body.only) args.push('-Only', ...csv(body.only));
      if (body.exclude) args.push('-Exclude', ...csv(body.exclude));

      const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
      child = spawn(ps, args, { cwd: path.resolve(AI_LOOP_DIR, '..', '..'), detached: process.platform !== 'win32', stdio: 'ignore' });
      child.unref();
      runInfo = { pid: child.pid, root, port, startedAt: new Date().toISOString() };
      child.on('exit', () => { child = null; runInfo = null; });
      return sendJson(res, 200, { started: true, ...runInfo });
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const stopped = await killLoop();
      return sendJson(res, 200, { stopped });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI Loop UI: http://127.0.0.1:${PORT}`);
});
