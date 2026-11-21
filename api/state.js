'use strict';
const { wrap } = require('../lib/http');
const S = require('../lib/state');
const push = require('../lib/push');

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

  // Strict role whitelist & authorization boundary
  if (!['admin', 'principal', 'teacher'].includes(user.role)) {
    return json(403, { error: 'Unauthorized role.' });
  }

  // Payload size & structure limits
  if (Array.isArray(client.items) && client.items.length > 5000) return json(400, { error: 'Too many items (max 5000).' });
  if (Array.isArray(client.bills) && client.bills.length > 5000) return json(400, { error: 'Too many bills (max 5000).' });
  if (Array.isArray(client.reqs) && client.reqs.length > 5000) return json(400, { error: 'Too many slips (max 5000).' });

  // Teacher permission guard: cannot modify stock, bills, faculty, or approvals
  if (user.role === 'teacher') {
    if (!Array.isArray(client.reqs)) return json(400, { error: 'Invalid requisition data.' });
    if (client.reqs.length > 50) return json(400, { error: 'Too many slips in a single submission (max 50).' });
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data: cur, version } = await store.getState();
    let next, assigned = {};
    if (user.role === 'admin') next = S.applyAdmin(cur, client);
    else if (user.role === 'principal') next = S.applyPrincipal(cur, client.reqs);
    else { const r = S.applyTeacher(cur, client.reqs, user.name); next = r.state; assigned = r.assigned; }
    const nv = await store.casState(version, next);
    if (nv) {
      await push.dispatchStateNotifications(store, user, cur, next).catch((err) => {
        console.error('Push dispatch error:', err ? err.message : err);
      });
      return json(200, { version: nv, data: S.viewFor(user, next), assigned });
    }
  }
  json(409, { error: 'Others are saving at the same time. Please try again.' });
});
