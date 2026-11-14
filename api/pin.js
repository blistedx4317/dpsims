'use strict';
const { wrap } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/state');

/* first sign-in (or after an admin reset): the user chooses their own PIN */
module.exports = wrap(['POST'], async ({ store, user, body, res, json }) => {
  const p = A.pinProblem(body.pin);
  if (p) return json(400, { error: p });
  const f = { pin_hash: await A.hashSecret(body.pin), must_change: false };
  if (user.must_change) f.pw_hash = await A.hashSecret(A.tempPassword() + A.tempPassword()); // the temporary password stops working
  const [upd, stateObj] = await Promise.all([
    store.updateUser(user.id, f),
    store.getState().catch(() => null)
  ]);
  res.setHeader('Set-Cookie', A.makeCookie(upd || user));
  const payload = { ok: true, role: user.role, name: user.name, mustSetPin: false };
  if (stateObj && stateObj.data) {
    payload.state = { version: stateObj.version, data: S.viewFor(user, stateObj.data) };
  }
  json(200, payload);
}, { allowMustChange: true });
