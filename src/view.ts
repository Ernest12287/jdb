/**
 * Built-in data visualizer: a tiny zero-dependency HTTP server that renders
 * all collections in a Supabase-style read-only grid.
 *
 * Endpoints:
 *   GET /                -> HTML dashboard (auto-refreshes every 2s)
 *   GET /api/collections -> JSON list of collections with row counts + schemas
 *   GET /api/data/:name  -> JSON records of one collection
 */

import { createServer, type Server } from 'node:http';
import { exec } from 'node:child_process';
import type { ViewConfig } from './types.js';

export interface ViewerHandle {
  url: string;
  port: number;
  close: () => void;
}

interface DbLike {
  listCollections(): string[];
  getSchema(name: string): unknown;
  from(name: string): { all(): unknown[] };
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    exec(`${cmd} ${url}`);
  } catch {
    /* best effort only */
  }
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>jdb viewer</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background:#0b0e14; color:#e6e6e6; display:flex; height:100vh; }
  nav { width: 220px; border-right:1px solid #1f2530; padding:16px; }
  nav h1 { font-size: 16px; margin: 0 0 12px; color:#7aa2f7; }
  nav button { display:block; width:100%; text-align:left; background:none; border:none; color:#c0caf5; padding:8px; cursor:pointer; border-radius:6px; font-size:14px; }
  nav button:hover, nav button.active { background:#161b2a; }
  nav .count { float:right; color:#565f89; }
  main { flex:1; overflow:auto; padding:16px; }
  table { border-collapse: collapse; width:100%; font-size:13px; }
  th, td { border:1px solid #1f2530; padding:6px 10px; text-align:left; vertical-align:top; }
  th { background:#161b2a; position:sticky; top:0; }
  pre.schema { background:#161b2a; padding:12px; border-radius:8px; overflow:auto; }
  .muted { color:#565f89; }
</style>
</head>
<body>
<nav><h1>&#128230; jdb</h1><div id="cols"></div><p class="muted" id="ro"></p></nav>
<main id="main">Select a collection.</main>
<script>
let current = null;
async function loadCollections() {
  const res = await fetch('/api/collections');
  const cols = await res.json();
  const el = document.getElementById('cols');
  el.innerHTML = '';
  for (const c of cols) {
    const b = document.createElement('button');
    b.innerHTML = c.name + '<span class="count">' + c.count + '</span>';
    b.className = c.name === current ? 'active' : '';
    b.onclick = () => { current = c.name; loadTable(c); };
    el.appendChild(b);
  }
}
async function loadTable(col) {
  const res = await fetch('/api/data/' + encodeURIComponent(col.name));
  const rows = await res.json();
  const main = document.getElementById('main');
  if (!rows.length) { main.innerHTML = '<p class="muted">No records in <b>' + col.name + '</b>.</p><pre class="schema">' + JSON.stringify(col.schema, null, 2) + '</pre>'; return; }
  const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
  let html = '<h2>' + col.name + ' <span class="muted">(' + rows.length + ')</span></h2><table><tr>';
  for (const k of keys) html += '<th>' + k + '</th>';
  html += '</tr>';
  for (const r of rows) {
    html += '<tr>';
    for (const k of keys) {
      const v = r[k];
      html += '<td>' + (v === undefined || v === null ? '<span class=muted>null</span>' : (typeof v === 'object' ? JSON.stringify(v) : String(v))) + '</td>';
    }
    html += '</tr>';
  }
  html += '</table><h3>Schema</h3><pre class="schema">' + JSON.stringify(col.schema, null, 2) + '</pre>';
  main.innerHTML = html;
}
loadCollections();
setInterval(loadCollections, 2000);
</script>
</body>
</html>`;

export function startViewer(db: DbLike, config: ViewConfig = {}): ViewerHandle {
  const port = config.port ?? 3000;
  const readOnly = config.readOnly ?? true;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
      }
      if (url.pathname === '/api/collections') {
        const payload = db.listCollections().map((name) => ({
          name,
          count: db.from(name).all().length,
          schema: db.getSchema(name) ?? null,
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      const dataMatch = /^\/api\/data\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (dataMatch) {
        const rows = db.from(dataMatch[1]).all();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rows));
        return;
      }
      if (readOnly && url.pathname.startsWith('/api/mutate')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'viewer is read-only' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  server.listen(port);
  const handle: ViewerHandle = {
    url: `http://localhost:${port}`,
    port,
    close: () => server.close(),
  };
  if (config.autoOpen) openBrowser(handle.url);
  return handle;
}
