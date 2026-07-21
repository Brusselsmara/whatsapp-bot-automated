const CACHE = 'romela-pula-v1';
const SHELL = ['/index.html', '/styles.css', '/app.js', '/manifest.webmanifest'];

/** App shell — always try network first so UI updates reach installed PWAs. */
function isShellRequest(url) {
  const path = url.pathname;
  if (path === '/' || path === '/index.html') return true;
  return SHELL.includes(path) || path.endsWith('.css') || path.endsWith('.js');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'SW_UPDATED' }));
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (isShellRequest(url)) {
    event.respondWith(networkFirstShell(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) =>
      cached || fetch(request).catch(() => cached)
    )
  );
});

async function networkFirstShell(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await cache.match('/index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}
