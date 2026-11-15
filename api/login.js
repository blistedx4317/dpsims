'use strict';
const { wrap } = require('../lib/http');
const A = require('../lib/auth');

module.exports = wrap(['POST'], async ({ store, body, ip, res, json }) => {
  const isDebug = process.env.DEBUG_LOGIN === '1';
  if (isDebug) console.time(`[LOGIN] total ip=${ip}`);

  const role = body.role, method = body.method, secret = body.secret;
  if (!['admin', 'principal', 'teacher'].includes(role) || !['pin', 'pw'].includes(method) || typeof secret !== 'string' || !secret || secret.length > 200)
    return json(400, { error: 'Invalid request.' });
  const name = role === 'admin' ? 'Administrator' : role === 'principal' ? 'Principal' : String(body.name || '').trim().slice(0, 80);
  if (!name) return json(400, { error: 'Select your name.' });

  const key = `${ip}|${role}|${name}`;
  if (isDebug) console.time('[LOGIN] db_lookup');
  const [wait, u] = await Promise.all([
    A.checkLock(store, key),
    store.findUser(role, name)
  ]);
  if (isDebug) console.timeEnd('[LOGIN] db_lookup');

  if (wait) {
    if (isDebug) console.timeEnd(`[LOGIN] total ip=${ip}`);
    return json(429, { error: 'Too many attempts. Please wait.', retryAfter: wait });
  }

  if (isDebug) console.time('[LOGIN] hash_verify');
  let ok = false;
  if (u && u.active) ok = await A.verifySecret(secret, method === 'pin' ? u.pin_hash : u.pw_hash);
  else await A.dummyVerify(secret);
  if (isDebug) console.timeEnd('[LOGIN] hash_verify');

  if (!ok) {
    const w = await A.recordFail(store, key);
    if (isDebug) console.timeEnd(`[LOGIN] total ip=${ip}`);
    return w ? json(429, { error: 'Too many attempts. Please wait.', retryAfter: w }) : json(401, { error: 'Incorrect credentials.' });
  }

  store.clearAttempt(key).catch(() => {});
  res.setHeader('Set-Cookie', A.makeCookie(u));
  if (isDebug) console.timeEnd(`[LOGIN] total ip=${ip}`);
  json(200, { ok: true, role: u.role, name: u.name, mustSetPin: !!u.must_change });
}, { public: true, skipSession: true });
