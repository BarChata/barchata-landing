// BarChata web app service worker: keeps the app shell available so it
// opens instantly from the home screen. Data (Supabase) is never cached.
const CACHE = 'bc-app-v1';
const SHELL = ['/app', '/app/app.css', '/app/app.js', '/app/config.js', '/app/manifest.webmanifest', '/app/vendor/supabase.js', '/app/vendor/qrcode.js', '/assets/barchata-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Pages: network first so updates arrive; fall back to the cached shell offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/app')));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
  }
});
