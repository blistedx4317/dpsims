'use strict';
const { wrap } = require('../lib/http');

/* Public asset endpoint: serves images and fonts stored in Neon database */
module.exports = wrap(['GET', 'POST'], async ({ store, req, res, query, body, user }) => {
  if (req.method === 'POST') {
    // Only logged-in admin can upload/update assets
    if (!user || user.role !== 'admin') {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Admin only' }));
    }
    const { key, contentType, data } = body;
    if (!key || !contentType || !data) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Missing key, contentType, or data' }));
    }
    await store.setAsset(key, contentType, data);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, key }));
  }

  const key = query.key;
  if (!key) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Missing asset key' }));
  }

  const asset = await store.getAsset(key);
  if (!asset) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Asset not found' }));
  }

  res.setHeader('Content-Type', asset.content_type);
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

  if (asset.content_type.startsWith('image/')) {
    // Decode base64 to binary buffer
    const cleanB64 = asset.data.replace(/^data:image\/[^;]+;base64,/, '');
    const buf = Buffer.from(cleanB64, 'base64');
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  } else {
    // Text/CSS or others
    const buf = Buffer.from(asset.data, 'utf-8');
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  }
}, { public: true });

