'use strict';
const { wrap } = require('../lib/http');
const A = require('../lib/auth');
module.exports = wrap(['POST'], async ({ res, json }) => {
  res.setHeader('Set-Cookie', A.clearCookie());
  json(200, { ok: true });
}, { public: true });
