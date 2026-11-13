'use strict';
const { wrap } = require('../lib/http');
const A = require('../lib/auth');
/* first sign-in (or after an admin reset): the user chooses their own PIN */
module.exports = wrap(['POST'], async ({ store, user, body, json }) => {
  const p = A.pinProblem(body.pin);
  if (p) return json(400, { error: p });
  const f = { pin_hash: await A.hashSecret(body.pin), must_change: false };
  if (user.must_change) f.pw_hash = await A.hashSecret(A.tempPassword() + A.tempPassword()); // the temporary password stops working
  await store.updateUser(user.id, f);
  json(200, { ok: true });
}, { allowMustChange: true });
