/* Time Dial — service worker
 * Relative paths so it works under a GitHub Pages project subpath
 * (e.g. https://username.github.io/time-dial/).
 *
 * Bump VERSION whenever you deploy changed files so returning
 * visitors pick up the new app shell.
 */
const VERSION = 'v1';

const SHELL_CACHE   = `time-dial-shell-${VERSION}`;
const RUNTIME_CACHE = `time-dial-runtime-${VERSION}`;
const FONT_CACHE    = `time-dial-fonts-${VERSION}`;
const ACTIVE_CACHES = [SHELL_CACHE, RUNTIME_CACHE, FONT_CACHE];

/* App shell: everything needed to render the app with no connection.
   Paths are relative to the service worker's scope. */
const PRECACHE = [
  './',
  './index.html',
  './offline.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

/* Only these third-party hosts are cached (web fonts).
   Every other cross-origin request — notably Google Sign-In and the
   Drive REST API used by the built-in sync — is intentionally NOT cached
   so tokens and private data are never stored by the worker. */
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/* ---------- install: pre-cache the shell ---------- */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    /* Cache one-by-one so a single missing/unfetchable file can't abort
       the whole install. */
    await Promise.all(PRECACHE.map(async url => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        /* ignore — the fetch handler still degrades gracefully */
      }
    }));
    await self.skipWaiting();
  })());
});

/* ---------- activate: drop stale caches ---------- */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => !ACTIVE_CACHES.includes(key))
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

/* ---------- fetch routing ---------- */
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }

  /* 1. Page navigations: network-first, fall back to the cached shell. */
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  /* 2. Our own assets: cache-first with a background refresh. */
  if (url.origin === self.location.origin) {
    event.respondWith(handleAsset(request));
    return;
  }

  /* 3. Web fonts: stale-while-revalidate so typography survives offline
        after the first visit. */
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(handleFont(request));
    return;
  }

  /* 4. Anything else (Google APIs, sign-in, etc.): pass straight through.
        The app already handles these failing gracefully while offline. */
});

/* ---------- handlers ---------- */
async function handleNavigation(request) {
  const runtime = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) runtime.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await runtime.match(request);
    if (cached) return cached;
    return (await caches.match('./index.html')) ||
           (await caches.match('./offline.html')) ||
           new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function handleAsset(request) {
  const cached = await caches.match(request);
  const network = fetch(request).then(response => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(RUNTIME_CACHE).then(cache => cache.put(request, copy));
    }
    return response;
  }).catch(() => null);

  if (cached) return cached;
  const response = await network;
  return response || new Response('', { status: 504, statusText: 'Offline' });
}

async function handleFont(request) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then(response => {
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  return cached || (await network) ||
         new Response('', { status: 504, statusText: 'Offline' });
}

/* ---------- optional manual update hook ---------- */
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
