// Service worker for the phone PWA (PLAN-maw-mobile.md). Network-only: maw data is live,
// never serve stale agent state from cache. Only job besides "Install app": receive Android shares.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

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
