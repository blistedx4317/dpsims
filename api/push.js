'use strict';
const { wrap } = require('../lib/http');
const push = require('../lib/push');

module.exports = wrap(['GET', 'POST', 'DELETE'], async ({ req, store, user, body, json }) => {
  if (req.method === 'GET') {
    await store.ensurePushTable().catch(() => {});
    const publicKey = await push.getPublicKey(store);
    return json(200, { ok: true, publicKey });
  }

  if (!user) return json(401, { error: 'Please sign in again.' });

  if (req.method === 'POST') {
    if (body.test) {
      await store.ensurePushTable().catch(() => {});
      if (body.subscription && body.subscription.endpoint && body.subscription.keys) {
        await store.savePushSubscription(user.id, user.role, user.name, body.subscription).catch(() => {});
      }
      const targets = user.role === 'teacher' ? [{ role: 'teacher', name: user.name }] : [{ role: user.role }];
      const sentCount = await push.sendToTargets(store, targets, {
        title: 'DPS IMS: Live Alert Test',
        body: 'Alerts are working! You will receive updates even when your phone is locked.',
        url: '/'
      });
      return json(200, { ok: true, testSent: true, count: sentCount });
    }

    const sub = body.subscription;
    if (!sub || !sub.endpoint || !sub.keys) {
      return json(400, { error: 'Invalid subscription object.' });
    }
    await store.ensurePushTable().catch(() => {});
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
