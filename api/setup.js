'use strict';
const { wrap, safeEq } = require('../lib/http');
const A = require('../lib/auth');

/* One-time set-up: creates the tables and the Admin + Principal sign-ins.
   Permanently disabled if users already exist. Refuses to run twice. */
module.exports = wrap(['POST'], async ({ store, body, json }) => {
  await store.init().catch(() => {});
  const userCount = await store.countUsers().catch(() => 0);
  if (userCount > 0) {
    return json(409, { error: 'Setup is permanently disabled. System is already initialized.' });
  }

  const tok = process.env.SETUP_TOKEN;
  if (!tok || tok.length < 8) return json(503, { error: 'SETUP_TOKEN is not configured on the server.' });
  if (typeof body.token !== 'string' || !safeEq(body.token, tok)) return json(403, { error: 'Wrong set-up token.' });

  const { adminPassword, adminPin, principalPassword, principalPin } = body;
  for (const [label, v] of [['Admin password', adminPassword], ['Principal password', principalPassword]]) {
    const p = A.passwordProblem(v);
    if (p) return json(400, { error: `${label}: ${p}` });
  }
  for (const [label, v] of [['Admin PIN', adminPin], ['Principal PIN', principalPin]]) {
    const p = A.pinProblem(v);
    if (p) return json(400, { error: `${label}: ${p}` });
  }

  await store.createUser({ role: 'admin', name: 'Administrator', pin_hash: await A.hashSecret(adminPin), pw_hash: await A.hashSecret(adminPassword), must_change: false });
  await store.createUser({ role: 'principal', name: 'Principal', pin_hash: await A.hashSecret(principalPin), pw_hash: await A.hashSecret(principalPassword), must_change: false });
  json(200, { ok: true });
}, { public: true });
