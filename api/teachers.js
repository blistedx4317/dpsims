'use strict';
const { wrap } = require('../lib/http');
/* names only, so the sign-in screen can show the "Select your name" list */
module.exports = wrap(['GET'], async ({ store, json }) => {
  const all = await store.listUsers();
  json(200, { names: all.filter((u) => u.role === 'teacher' && u.active).map((u) => u.name).sort((a, b) => a.localeCompare(b)) });
}, { public: true });
