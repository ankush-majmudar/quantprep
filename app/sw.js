/* QuantPrep service worker — offline-first */
const VERSION = "qp-v3";
const CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./bank.json",
  "./manifest.json",
  "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css",
  "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js",
  "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js",
  "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/fonts/KaTeX_Main-Regular.woff2",
  "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/fonts/KaTeX_Math-Italic.woff2",
  "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/fonts/KaTeX_Size1-Regular.woff2",
  "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/fonts/KaTeX_Size2-Regular.woff2",
  "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/fonts/KaTeX_AMS-Regular.woff2"
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(CORE.map((u) => c.add(u)))));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never cache the Anthropic API (live mode)
  if (url.hostname.endsWith("anthropic.com")) return;

  // Network-first for bank.json so content updates propagate
  if (url.pathname.endsWith("bank.json")) {
    e.respondWith(
      fetch(req).then((res) => { const c = res.clone(); caches.open(VERSION).then((cc) => cc.put(req, c)); return res; })
                .catch(() => caches.match(req))
    );
    return;
  }
  // Cache-first for everything else
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && (url.origin === location.origin || url.hostname.includes("jsdelivr"))) {
        const c = res.clone(); caches.open(VERSION).then((cc) => cc.put(req, c));
      }
      return res;
    }).catch(() => hit))
  );
});
