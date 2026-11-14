'use strict';
const { wrap } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/state');

module.exports = wrap(['POST'], async ({ store, body, ip, res, json }) => {
  const role = body.role, method = body.method, secret = body.secret;
  if (!['admin', 'principal', 'teacher'].includes(role) || !['pin', 'pw'].includes(method) || typeof secret !== 'string' || !secret || secret.length > 200)
    return json(400, { error: 'Invalid request.' });
  const name = role === 'admin' ? 'Administrator' : role === 'principal' ? 'Principal' : String(body.name || '').trim().slice(0, 80);
  if (!name) return json(400, { error: 'Select your name.' });

  const key = `${ip}|${role}|${name}`;
  const [wait, u, stateObj] = await Promise.all([
    A.checkLock(store, key),
    store.findUser(role, name),
    store.getState().catch(() => null)
  ]);
  if (wait) return json(429, { error: 'Too many attempts. Please wait.', retryAfter: wait });

  let ok = false;
  if (u && u.active) ok = await A.verifySecret(secret, method === 'pin' ? u.pin_hash : u.pw_hash);
  else await A.dummyVerify(secret);

  if (!ok) {
    const w = await A.recordFail(store, key);
    return w ? json(429, { error: 'Too many attempts. Please wait.', retryAfter: w }) : json(401, { error: 'Incorrect credentials.' });
  }
  store.clearAttempt(key).catch(() => {});
  res.setHeader('Set-Cookie', A.makeCookie(u));
  const payload = { ok: true, role: u.role, name: u.name, mustSetPin: !!u.must_change };
  if (stateObj && stateObj.data) {
    payload.state = { version: stateObj.version, data: S.viewFor(u, stateObj.data) };
  }
  json(200, payload);
}, { public: true });
