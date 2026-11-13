'use strict';
const { wrap } = require('../lib/http');
const A = require('../lib/auth');

module.exports = wrap(['POST'], async ({ store, body, ip, res, json }) => {
  const role = body.role, method = body.method, secret = body.secret;
  if (!['admin', 'principal', 'teacher'].includes(role) || !['pin', 'pw'].includes(method) || typeof secret !== 'string' || !secret || secret.length > 200)
    return json(400, { error: 'Invalid request.' });
  const name = role === 'admin' ? 'Administrator' : role === 'principal' ? 'Principal' : String(body.name || '').trim().slice(0, 80);
  if (!name) return json(400, { error: 'Select your name.' });

  const key = `${ip}|${role}|${name}`;
  const wait = await A.checkLock(store, key);
  if (wait) return json(429, { error: 'Too many attempts. Please wait.', retryAfter: wait });

  const u = await store.findUser(role, name);
  let ok = false;
  if (u && u.active) ok = await A.verifySecret(secret, method === 'pin' ? u.pin_hash : u.pw_hash);
  else await A.dummyVerify(secret);

  if (!ok) {
    const w = await A.recordFail(store, key);
    return w ? json(429, { error: 'Too many attempts. Please wait.', retryAfter: w }) : json(401, { error: 'Incorrect credentials.' });
  }
  await store.clearAttempt(key);
  res.setHeader('Set-Cookie', A.makeCookie(u));
  json(200, { ok: true, role: u.role, name: u.name, mustSetPin: !!u.must_change });
}, { public: true });
