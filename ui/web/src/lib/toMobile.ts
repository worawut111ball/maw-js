/** Back to maw mobile (/m.html) on the node this page talks to — the one in ?host= when opened from the mobile ⋯ menu. */
export function toMobileApp() {
  try { sessionStorage.removeItem("maw-desktop"); } catch { /* private mode */ }
  const host = new URLSearchParams(location.search).get("host");
  let base = location.origin;
  try { if (host) base = new URL(/^https?:\/\//.test(host) ? host : `http://${host}`).origin; } catch { /* keep this origin */ }
  location.href = `${base}/m.html`;
}
