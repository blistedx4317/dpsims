'use strict';
const { wrap } = require('../lib/http');
module.exports = wrap(['GET'], async ({ user, json }) => {
  json(200, { role: user.role, name: user.name, mustSetPin: !!user.must_change });
}, { allowMustChange: true });
