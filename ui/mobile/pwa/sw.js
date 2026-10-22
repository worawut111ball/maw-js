// Service worker for the phone PWA (PLAN-maw-mobile.md). Network-only: maw data is live,
// never serve stale agent state from cache. Only job besides "Install app": receive Android shares.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

// The app page and feature packs must always come fresh from the Mac (Chrome otherwise keeps a cached copy
// and the phone runs an old version after an update).
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname === "/m.html" || url.pathname.startsWith("/m-ext/") || url.pathname === "/manifest.json")
    e.respondWith(fetch(e.request, { cache: "no-store" }).catch(() => fetch(e.request)));
});

// Share sheet → "maw": Android POSTs the screenshot/file here (manifest share_target).
// Park the files in a cache, then open the app, which asks which room to put them in.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "POST" || url.pathname !== "/share-target") return;
  e.respondWith((async () => {
    const form = await e.request.formData();
    const files = form.getAll("files").filter(f => f && f.size);
    const text = [form.get("title"), form.get("text"), form.get("url")].filter(Boolean).join("\n");
    const box = await caches.open("maw-share");
    for (const k of await box.keys()) await box.delete(k);
    let n = 0;
    for (const f of files) await box.put(`/shared/${n++}`, new Response(f, { headers: { "content-type": f.type || "application/octet-stream", "x-name": encodeURIComponent(f.name || "file") } }));
    if (text) await box.put("/shared/text", new Response(text));
    // what Android actually sent (names/types/sizes only) — helps when a share arrives empty
    await box.put("/shared/debug", new Response(JSON.stringify([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? "text:" + v.length : `${v.type}:${v.size}`]))));
    return Response.redirect(`/m.html?shared=${n}`, 303);
  })());
});

// Push from the Mac (agent waiting / done) → system notification; tap opens that room.
self.addEventListener("push", e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: "maw", body: e.data?.text() || "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "maw", {
    body: d.body || "", tag: d.tag || "maw", renotify: true, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url || "/m.html" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = e.notification.data?.url || "/m.html";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find(c => new URL(c.url).pathname === "/m.html");
    if (w) { await w.focus(); w.postMessage({ type: "open", url }); return; }
    await self.clients.openWindow(url);
  })());
});
