'use strict';
const { wrap } = require('../lib/http');
const S = require('../lib/state');

module.exports = wrap(['GET'], async ({ store, user, json }) => {
  const payload = { role: user.role, name: user.name, mustSetPin: !!user.must_change };
  if (!user.must_change) {
    const stateObj = await store.getState().catch(() => null);
    if (stateObj && stateObj.data) {
      payload.state = { version: stateObj.version, data: S.viewFor(user, stateObj.data) };
    }
  }
  json(200, payload);
}, { allowMustChange: true });
