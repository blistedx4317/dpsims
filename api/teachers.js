'use strict';
const { wrap } = require('../lib/http');

/* Public names-only endpoint for the login dropdown list */
module.exports = wrap(['GET'], async ({ store, json }) => {
  const all = await store.listUsers();
  json(200, { names: all.filter((u) => u.role === 'teacher' && u.active).map((u) => u.name).sort((a, b) => a.localeCompare(b)) });
}, { public: true });
