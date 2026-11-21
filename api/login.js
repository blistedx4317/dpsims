'use strict';
const { wrap } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/state');

module.exports = wrap(['GET', 'POST'], async ({ req, store, body, ip, res, json }) => {
  if (req.method === 'GET') {
    await Promise.all([
      store.listUsers().catch(() => {}),
      store.getState().catch(() => {})
    ]);
    return json(200, { ok: true, warm: true });
  }

  const isDebug = process.env.DEBUG_LOGIN === '1';
  if (isDebug) console.time(`[LOGIN] total ip=${ip}`);

  const role = body.role, method = body.method, secret = body.secret;
  if (!['admin', 'principal', 'teacher'].includes(role) || !['pin', 'pw'].includes(method) || typeof secret !== 'string' || !secret || secret.length > 200)
    return json(400, { error: 'Invalid request.' });
  const name = role === 'admin' ? 'Administrator' : role === 'principal' ? 'Principal' : String(body.name || '').trim().slice(0, 80);
  if (!name) return json(400, { error: 'Select your name.' });

  const ipKey = `ip:${ip}|${role}|${name}`;
  const acctKey = `acct:${role}|${name}`;
  if (isDebug) console.time('[LOGIN] db_lookup');
  const [wait, u, stateObj] = await Promise.all([
    A.checkProgressiveLock(store, ipKey, acctKey),
    store.findUser(role, name),
    store.getState().catch(() => null)
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
    const w = await A.recordProgressiveFail(store, ipKey, acctKey);
    if (isDebug) console.timeEnd(`[LOGIN] total ip=${ip}`);
    return w ? json(429, { error: 'Too many attempts. Please wait.', retryAfter: w }) : json(401, { error: 'Incorrect credentials.' });
  }

  A.clearProgressiveAttempts(store, ipKey, acctKey);
  res.setHeader('Set-Cookie', A.makeCookie(u));
  if (isDebug) console.timeEnd(`[LOGIN] total ip=${ip}`);
  const payload = { ok: true, role: u.role, name: u.name, mustSetPin: !!u.must_change };
  if (stateObj && stateObj.data && !u.must_change) {
    payload.state = { version: stateObj.version, data: S.viewFor(u, stateObj.data) };
  }
  json(200, payload);
}, { public: true, skipSession: true });
