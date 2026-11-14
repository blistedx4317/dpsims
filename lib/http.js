'use strict';
const crypto = require('crypto');
const { getStore } = require('./store');
const auth = require('./auth');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  return (f ? String(f).split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
}
function bodyOf(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* wrap(methods, handler, { public, roles, allowMustChange }) */
function wrap(methods, fn, opts = {}) {
  return async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (!methods.includes(req.method)) { res.setHeader('Allow', methods.join(', ')); return json(res, 405, { error: 'Method not allowed' }); }
      if (req.method !== 'GET') {            // same-origin requests only (CSRF)
        const o = req.headers.origin;
        if (o) {
          let h = '';
          try { h = new URL(o).host; } catch (e) { /* bad origin */ }
          const reqHosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
          const isAllowed = reqHosts.some((x) => x === h || x.split(':')[0] === h.split(':')[0]) || (h && h.endsWith('.vercel.app'));
          if (!isAllowed) return json(res, 403, { error: 'Bad origin' });
        }
      }
      const store = getStore();
      const query = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      const ctx = { req, res, store, body: bodyOf(req), query, ip: clientIp(req), json: (c, o) => json(res, c, o) };
      const u = await auth.sessionUser(req, store);
      if (!opts.public) {
        if (!u) return json(res, 401, { error: 'Please sign in again.' });
        if (u.must_change && !opts.allowMustChange) return json(res, 403, { error: 'Please set your new PIN first.', code: 'set_pin' });
        if (opts.roles && !opts.roles.includes(u.role)) return json(res, 403, { error: 'Not allowed.' });
      }
      ctx.user = u;
      await fn(ctx);
    } catch (e) {
      console.error('API error:', e && e.stack || e);
      json(res, 500, { error: 'Server error. Please try again.' });
    }
  };
}
module.exports = { wrap, json, safeEq };
