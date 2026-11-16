'use strict';
const { wrap } = require('../lib/http');
const push = require('../lib/push');

module.exports = wrap(['GET', 'POST', 'DELETE'], async ({ req, store, user, body, json }) => {
  if (req.method === 'GET') {
    const publicKey = await push.getPublicKey(store);
    return json(200, { ok: true, publicKey });
  }

  if (!user) return json(401, { error: 'Please sign in again.' });

  if (req.method === 'POST') {
    const sub = body.subscription;
    if (!sub || !sub.endpoint || !sub.keys) {
      return json(400, { error: 'Invalid subscription object.' });
    }
    const ok = await store.savePushSubscription(user.id, user.role, user.name, sub);
    return json(200, { ok: !!ok });
  }

  if (req.method === 'DELETE') {
    const endpoint = body.endpoint;
    if (!endpoint) return json(400, { error: 'Endpoint required.' });
    await store.deletePushSubscription(endpoint);
    return json(200, { ok: true });
  }
}, { public: true });
