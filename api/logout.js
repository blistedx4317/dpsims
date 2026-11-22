'use strict';
const { wrap } = require('../lib/http');
const A = require('../lib/auth');

module.exports = wrap(['POST'], async ({ req, store, user, res, json }) => {
  if (user && user.id) {
    await store.updateUser(user.id, { bump: 1 }).catch(() => {});
  }
  res.setHeader('Set-Cookie', A.clearCookies(req));
  json(200, { ok: true });
}, { public: true });
