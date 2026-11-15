/* DPS Amrapali IMS - Progressive Web App Service Worker */
const CACHE_NAME = 'dps-ims-v1.0.16';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/favicon.png',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/api/assets?key=fonts.css',
  '/api/assets?key=logo'
];

// Install: Cache critical shell assets safely
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const url of STATIC_ASSETS) {
        try {
          const res = await fetch(url, { cache: 'no-cache' });
          if (res && res.status === 200) {
            await cache.put(url, res);
          }
        } catch (e) {
          // non-fatal
        }
      }
    }).then(() => self.skipWaiting())
  );
});

// Activate: Clean up previous caches & take control immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Strategy depending on request type
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Ignore non-GET requests (e.g. POST to /api/login, /api/state)
  if (req.method !== 'GET') {
    return;
  }

  // Handle Chrome extension schemes or other origins
  if (!url.origin.includes(self.location.origin) && !url.origin.includes('vercel.app')) {
    return;
  }

  // 1. Navigation requests (App Shell): Always try network first, then cache, then fallback. NEVER return undefined!
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const cached = (await caches.match('/index.html')) || (await caches.match('/'));
        if (cached) return cached;
        return fetch('/index.html').catch(() => {
          return new Response(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>DPS IMS</title><meta http-equiv="refresh" content="2"></head><body style="font-family:sans-serif;text-align:center;padding:50px;background:#f5f8f6"><h2>Connecting to DPS IMS...</h2><p>Please wait a moment while the portal connects.</p></body></html>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        });
      })
    );
    return;
  }

  // 2. Static Assets & Fonts/Logo: Cache First, fallback to network
  if (
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.webmanifest') ||
    url.pathname.endsWith('.json') ||
    (url.pathname === '/api/assets')
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((response) => {
          if (response && response.status === 200) {
            const respClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, respClone));
          }
          return response;
        }).catch(() => new Response('', { status: 404 }));
      })
    );
    return;
  }

  // 3. API Requests: Network first, never return invalid response
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() => {
        return new Response(JSON.stringify({ error: 'Network error. Please try again.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }
});
