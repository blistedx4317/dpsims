'use strict';
const { wrap } = require('../lib/http');
const A = require('../lib/auth');

module.exports = wrap(['GET', 'POST'], async ({ req, store, body, json }) => {
  if (req.method === 'GET') {
    const out = {};
    for (const u of await store.listUsers()) {
      if (u.role === 'teacher' && u.active) out[u.name] = { mustChange: !!u.must_change };
      if (u.role === 'principal') out['@principal'] = { mustChange: !!u.must_change };
    }
    return json(200, { users: out });
  }
  const action = body.action, rawName = String(body.name || '').trim().slice(0, 80);
  if (!rawName) return json(400, { error: 'Name is required.' });
  const isP = rawName === '@principal';
  const role = isP ? 'principal' : 'teacher', name = isP ? 'Principal' : rawName;
  const existing = await store.findUser(role, name);

  const issue = async () => {                       // temporary credentials, shown to the admin once
    const pin = A.tempPin(), pw = A.tempPassword();
    return { pin, pw, pin_hash: await A.hashSecret(pin), pw_hash: await A.hashSecret(pw) };
  };
  if (action === 'ensure') {
    if (isP) return json(400, { error: 'Not allowed.' });
    if (existing && existing.active) return json(200, { exists: true });
    const c = await issue();
    if (existing) await store.updateUser(existing.id, { pin_hash: c.pin_hash, pw_hash: c.pw_hash, must_change: true, active: true, bump: 1 });
    else await store.createUser({ role, name, pin_hash: c.pin_hash, pw_hash: c.pw_hash, must_change: true });
    return json(200, { created: true, pin: c.pin, pw: c.pw });
  }
  if (action === 'reset') {
    const c = await issue();
    if (existing) await store.updateUser(existing.id, { pin_hash: c.pin_hash, pw_hash: c.pw_hash, must_change: true, active: true, bump: 1 });
    else if (!isP) await store.createUser({ role, name, pin_hash: c.pin_hash, pw_hash: c.pw_hash, must_change: true });
    else return json(404, { error: 'Principal account not found.' });
    return json(200, { pin: c.pin, pw: c.pw });
  }
  if (action === 'delete') {
    if (isP) return json(400, { error: 'Not allowed.' });
    if (existing) await store.updateUser(existing.id, { active: false, bump: 1 });
    return json(200, { ok: true });
  }
  json(400, { error: 'Unknown action.' });
}, { roles: ['admin'] });
