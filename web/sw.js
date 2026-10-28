// Service worker mínimo: guarda el "cascarón" de la app para abrir rápido; los datos siempre vienen de la red.
const CACHE = "bitacora-v2";
const SHELL = ["/", "index.html", "css/app.css", "js/app.js", "js/auth.js", "js/api.js", "js/geo.js", "js/globe.js", "js/map.js", "js/photos.js", "js/trips.js", "js/util.js", "icon.svg"];

self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // red primero (para ver cambios al instante), caché si no hay conexión
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
