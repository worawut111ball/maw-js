// Minimal service worker so browsers offer "Install app". Network-only: maw data is live,
// never serve stale agent state from cache. Added for the phone PWA (PLAN-maw-mobile.md).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
