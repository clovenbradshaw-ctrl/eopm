/**
 * sw.js — App shell cache for offline boot
 *
 * Network-first for app shell GETs (HTML, JS, CSS, fonts). Falls back
 * to the cached copy when offline so the user can launch the app and
 * unlock their vault without a connection.
 *
 * Matrix API calls (anything to the homeserver) are passed straight
 * to the network — caching homeserver responses would corrupt sync.
 *
 * Cache busts on every deploy via CACHE_NAME. The Vite build outputs
 * hashed asset filenames so older copies in the cache stay correct
 * for older sessions.
 */

const CACHE_NAME = 'eopm-shell-v2';
const CORE_ASSETS = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(CORE_ASSETS).catch(() => {})
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Don't intercept cross-origin requests (homeserver, fonts CDN behave
  // best with normal network handling and CORS).
  if (url.origin !== self.location.origin) return;

  // Skip Matrix client API endpoints just in case they're same-origin.
  if (url.pathname.startsWith('/_matrix/')) return;

  // "Network-first" only actually means something if the network fetch
  // can't be silently satisfied from the browser's own disk cache — plain
  // fetch(req) uses the default cache mode, which DOES honor whatever
  // Cache-Control the last response carried (GitHub Pages sends max-age
  // for the HTML shell). That's exactly how a visit shortly after a
  // deploy can serve the previous, already-superseded app shell even
  // though this code is trying to go to the network. Vite's own output
  // (assets/<name>-<hash>.<ext>) is content-addressed and changes its URL
  // whenever its content does, so it's safe to let the browser cache
  // normally; every other same-origin GET is the app shell — force a real
  // network round-trip for those so a fresh deploy is never masked by a
  // stale disk-cache hit.
  const isHashedAsset = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(url.pathname);
  const fetchOpts = isHashedAsset ? {} : { cache: 'no-store' };

  event.respondWith(
    fetch(req, fetchOpts)
      .then((resp) => {
        // Cache successful same-origin GETs for offline fallback.
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return resp;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
