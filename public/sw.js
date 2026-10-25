// Service worker do Meu Semestre: guarda o app para abrir offline e recebe as notificações push.
const CACHE = "meu-semestre-v2";
const SCOPE = self.registration.scope; // ex.: https://usuario.github.io/APP-FACULDADE/
// Links das notificações vêm como "/?aba=..."; ficam relativos ao endereço do app
const appUrl = u => new URL(String(u || "").replace(/^\//, ""), SCOPE).href;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (req.mode === "navigate") {
    // Páginas: tenta a rede primeiro para pegar a versão nova; sem internet, usa a guardada
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(SCOPE, copy)); return res;
    }).catch(() => caches.match(SCOPE)));
    return;
  }
  // Arquivos com hash no nome não mudam, então podem vir do cache
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});

self.addEventListener("push", e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  const title = data.title || "Meu Semestre";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: appUrl("icons/icon-192.png"),
    badge: appUrl("icons/badge-96.png"),
    tag: data.tag,
    data: { url: data.url, actions: data.actionUrls || {} },
    actions: data.actions || [],
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const { url, actions } = e.notification.data || {};
  const target = appUrl((e.action && actions && actions[e.action]) || url);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate(target); }
    }
    return self.clients.openWindow(target);
  })());
});
