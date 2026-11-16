'use strict';

let _cachedVapid = null;
let _webpush = null;

async function getWebPush() {
  if (!_webpush) {
    const mod = await import('web-push');
    _webpush = mod.default || mod;
  }
  return _webpush;
}

async function getVapidKeys(store) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
      subject: process.env.VAPID_SUBJECT || 'mailto:admin@dpsamrapali.edu.in'
    };
  }
  if (_cachedVapid) return _cachedVapid;

  const asset = await store.getAsset('vapid_keys').catch(() => null);
  if (asset && asset.data) {
    try {
      const parsed = JSON.parse(asset.data);
      if (parsed.publicKey && parsed.privateKey) {
        _cachedVapid = { ...parsed, subject: parsed.subject || 'mailto:admin@dpsamrapali.edu.in' };
        return _cachedVapid;
      }
    } catch (e) {}
  }

  const wp = await getWebPush();
  const generated = wp.generateVAPIDKeys();
  const keys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: 'mailto:admin@dpsamrapali.edu.in'
  };
  await store.setAsset('vapid_keys', 'application/json', JSON.stringify(keys)).catch(() => {});
  _cachedVapid = keys;
  return keys;
}

async function initWebPush(store) {
  const wp = await getWebPush();
  const keys = await getVapidKeys(store);
  wp.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  return { wp, keys };
}

async function getPublicKey(store) {
  const keys = await getVapidKeys(store);
  return keys.publicKey;
}

async function sendToTargets(store, targets, payload) {
  let wp;
  try {
    const init = await initWebPush(store);
    wp = init.wp;
  } catch (e) {
    return;
  }

  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const seenEndpoints = new Set();
  const allSubs = [];

  for (const t of targets) {
    const subs = await store.getPushSubscriptions(t.role, t.name).catch(() => []);
    for (const s of subs) {
      if (!seenEndpoints.has(s.endpoint)) {
        seenEndpoints.add(s.endpoint);
        allSubs.push(s);
      }
    }
  }

  const promises = allSubs.map(async (sub) => {
    try {
      await wp.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      }, payloadStr);
    } catch (err) {
      // If subscription expired or unsubscribed, remove from DB
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        await store.deletePushSubscription(sub.endpoint).catch(() => {});
      }
    }
  });

  await Promise.allSettled(promises);
}

async function dispatchStateNotifications(store, actorUser, curState, nextState) {
  if (!curState || !nextState) return;
  const curReqs = Array.isArray(curState.reqs) ? curState.reqs : [];
  const nextReqs = Array.isArray(nextState.reqs) ? nextState.reqs : [];
  const curMap = new Map(curReqs.map((r) => [String(r.id), r]));

  for (const nr of nextReqs) {
    const cr = curMap.get(String(nr.id));
    if (!cr) {
      // Brand new requisition slip added
      if (nr.st === 'Pending') {
        const itemCount = (nr.it || []).length;
        await sendToTargets(store, [{ role: 'principal' }, { role: 'admin' }], {
          title: 'DPS IMS: New Requisition',
          body: `${nr.by || 'Teacher'} submitted Slip #${nr.id} (${itemCount} item${itemCount === 1 ? '' : 's'})`,
          url: '/#req',
          slipId: nr.id
        });
      }
    } else if (cr.st !== nr.st) {
      // Requisition slip status changed
      if (nr.st === 'Verified') {
        // Principal verified slip -> notify Teacher and Admin
        if (nr.by) {
          await sendToTargets(store, [{ role: 'teacher', name: nr.by }], {
            title: 'DPS IMS: Slip Verified',
            body: `Requisition #${nr.id} has been verified by the Principal.`,
            url: '/#my-slips',
            slipId: nr.id
          });
        }
        await sendToTargets(store, [{ role: 'admin' }], {
          title: 'DPS IMS: Verified Slip Ready',
          body: `Slip #${nr.id} (${nr.by}) verified by Principal. Ready for issue.`,
          url: '/#req',
          slipId: nr.id
        });
      } else if (nr.st === 'Approved') {
        // Admin approved / issued slip -> notify Teacher
        if (nr.by) {
          await sendToTargets(store, [{ role: 'teacher', name: nr.by }], {
            title: 'DPS IMS: Stock Issued',
            body: `Requisition #${nr.id} approved by Admin. Items ready for collection!`,
            url: '/#my-slips',
            slipId: nr.id
          });
        }
      } else if (nr.st === 'Declined') {
        // Declined -> notify Teacher
        if (nr.by) {
          await sendToTargets(store, [{ role: 'teacher', name: nr.by }], {
            title: 'DPS IMS: Slip Declined',
            body: `Requisition #${nr.id} was declined.`,
            url: '/#my-slips',
            slipId: nr.id
          });
        }
      }
    }
  }
}

module.exports = {
  getVapidKeys,
  getPublicKey,
  sendToTargets,
  dispatchStateNotifications
};
