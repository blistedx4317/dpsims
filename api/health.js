'use strict';
const { wrap } = require('../lib/http');

module.exports = wrap(['GET'], async ({ store, json }) => {
  try {
    if (store.ping) await store.ping();
    json(200, { ok: true, t: Date.now() });
  } catch (e) {
    json(500, { ok: false });
  }
}, { public: true, skipSession: true });
