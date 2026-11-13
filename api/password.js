'use strict';
const { wrap } = require('../lib/http');
const A = require('../lib/auth');
/* a signed-in user changes their own password and/or PIN */
module.exports = wrap(['POST'], async ({ store, user, body, ip, res, json }) => {
  const cur = typeof body.current === 'string' ? body.current : '';
  const newPw = typeof body.newPw === 'string' ? body.newPw : '';
  const newPin = typeof body.newPin === 'string' ? body.newPin : '';
  if (!cur) return json(400, { error: 'Please enter your current password or PIN.' });
  if (!newPw && !newPin) return json(400, { error: 'Enter a new password or a new 4-digit PIN.' });
  if (newPw) { const p = A.passwordProblem(newPw); if (p) return json(400, { error: p }); }
  if (newPin) { const p = A.pinProblem(newPin); if (p) return json(400, { error: p }); }

  const key = `chg|${user.id}|${ip}`;
  const wait = await A.checkLock(store, key);
  if (wait) return json(429, { error: 'Too many attempts. Please wait.', retryAfter: wait });
  const ok = (await A.verifySecret(cur, user.pw_hash)) || (await A.verifySecret(cur, user.pin_hash));
  if (!ok) {
    const w = await A.recordFail(store, key);
    return w ? json(429, { error: 'Too many attempts. Please wait.', retryAfter: w }) : json(401, { error: 'Current password or PIN is incorrect.' });
  }
  await store.clearAttempt(key);
  const upd = await store.updateUser(user.id, {
    pw_hash: newPw ? await A.hashSecret(newPw) : null,
    pin_hash: newPin ? await A.hashSecret(newPin) : null,
    bump: 1,                                       // signs out every other device
  });
  res.setHeader('Set-Cookie', A.makeCookie(upd));  // keep this device signed in
  json(200, { ok: true });
});
