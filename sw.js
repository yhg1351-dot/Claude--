// 서비스 워커: 앱 파일을 폰에 캐시해 신호가 약해도 화면이 열리게 한다.
// 네트워크 우선(최신 파일), 실패하면 캐시 사용. Supabase 요청은 건드리지 않는다.
const VERSION = "mq-v17";
const PRECACHE = [
  "./",
  "./index.html",
  "./teacher.html",
  "./css/app.css",
  "./js/config.js",
  "./js/app.js",
  "./js/teacher.js",
  "./js/backend.js",
  "./js/sync.js",
  "./js/store.js",
  "./js/image.js",
  "./js/data.js",
  "./js/editor.js",
  "./data/missions.json",
  "./vendor/supabase.js",
  "./vendor/fflate.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => Promise.allSettled(PRECACHE.map((u) => cache.add(u)))).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase 등 외부 요청은 그대로

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(req, { signal: ctrl.signal });
        clearTimeout(t);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        const cached = (await cache.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? await cache.match("./index.html") : null);
        if (cached) return cached;
        throw e;
      }
    })()
  );
});
