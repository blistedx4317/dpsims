'use strict';
const { wrap } = require('../lib/http');
const S = require('../lib/state');

module.exports = wrap(['GET', 'PUT'], async ({ req, store, user, body, json }) => {
  if (req.method === 'GET') {
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since'));
    if (since) {
      const v = await store.getStateVersion();
      if (since === v) return json(200, { unchanged: true, version: v });
    }
    const { data, version } = await store.getState();
    return json(200, { version, data: S.viewFor(user, data) });
  }

  const client = body.data;
  if (!client || typeof client !== 'object') return json(400, { error: 'No data.' });
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data: cur, version } = await store.getState();
    let next, assigned = {};
    if (user.role === 'admin') next = S.applyAdmin(cur, client);
    else if (user.role === 'principal') next = S.applyPrincipal(cur, client.reqs);
    else { const r = S.applyTeacher(cur, client.reqs, user.name); next = r.state; assigned = r.assigned; }
    const nv = await store.casState(version, next);
    if (nv) return json(200, { version: nv, data: S.viewFor(user, next), assigned });
  }
  json(409, { error: 'Others are saving at the same time. Please try again.' });
});
