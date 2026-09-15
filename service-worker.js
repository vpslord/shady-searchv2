const SHELL_CACHE = 'shady-search-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './worker.sql-wasm.js',
  './sql-wasm.wasm',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && !k.startsWith('shady-search-db'))
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// استراتيجية: من الكاش الأول، ولو مش موجود نجيبه من النت
self.addEventListener('fetch', (event) => {
  // ملفات البيانات (data/) بتتعامل معاها الصفحة نفسها عن طريق Cache API
  // الخاص بيها (shady-search-db-v1)، فمنستخدمش service worker fetch caching
  // ليها هنا عشان منكررش التخزين.
  if (event.request.url.includes('/data/')) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).catch(() => {
          return caches.match('./index.html');
        })
      );
    })
  );
});
