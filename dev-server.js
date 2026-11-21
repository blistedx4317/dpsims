'use strict';
/* Local server: node dev-server.js */
try { require('./nat64-preload.js'); } catch (e) {}
const http = require('http'), fs = require('fs'), path = require('path');

// Load .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m) {
      let v = (m[2] || '').trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  }
}

if (!process.env.DATABASE_URL && process.env.DPS_MEMORY === undefined) {
  process.env.DPS_MEMORY = '1';
}
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'dev-secret-dev-secret-dev-secret-123';
}
const PORT = process.env.PORT || 3000;
const routes = {};
for (const f of fs.readdirSync(path.join(__dirname, 'api'))) routes['/api/' + f.replace(/\.js$/, '')] = require('./api/' + f);

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  req.query = Object.fromEntries(u.searchParams);
  if (routes[u.pathname]) {
    let raw = ''; for await (const c of req) raw += c;
    try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = {}; }
    return routes[u.pathname](req, res);
  }
  const file = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  if (file.startsWith(path.join(__dirname, 'public')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
    return res.end(fs.readFileSync(file));
  }
  res.statusCode = 404; res.end('Not found');
}).listen(PORT, () => console.log('DPS dev server on http://localhost:' + PORT));
