import { Elysia, t } from "elysia";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

/**
 * Open Graph metadata fetcher for ป้าไล digest link previews.
 *
 *   GET /api/og?url=...  → { url, image, title, description, site, type, fetched_at }
 *
 * Cache: $HOME/oracle/ψ/incubate/yailai/og-cache/<sha1>.json (7-day TTL)
 *
 * Special handling:
 *   - YouTube → direct img.youtube.com thumbnail (no fetch)
 *   - X/Twitter → minimal (blocked OG)
 */

const CACHE_DIR = join(process.env.HOME || "", "oracle", "ψ", "incubate", "yailai", "og-cache");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface OGData {
  url: string;
  image?: string;
  title?: string;
  description?: string;
  site?: string;
  type?: string;
  video?: string;
  favicon?: string;
  fetched_at: string;
}

function cacheKey(url: string): string {
  return createHash("sha1").update(url).digest("hex");
}

function readCache(url: string): OGData | null {
  try {
    if (!existsSync(CACHE_DIR)) return null;
    const fp = join(CACHE_DIR, `${cacheKey(url)}.json`);
    if (!existsSync(fp)) return null;
    const data = JSON.parse(readFileSync(fp, "utf-8")) as OGData;
    const age = Date.now() - new Date(data.fetched_at).getTime();
    if (age > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(url: string, data: OGData): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const fp = join(CACHE_DIR, `${cacheKey(url)}.json`);
    writeFileSync(fp, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("og cache write failed:", err);
  }
}

// YouTube special handler — extract video ID, return direct thumbnail
function handleYouTube(url: string): OGData | null {
  // youtube.com/watch?v=ID
  let m = url.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/);
  // youtu.be/ID
  if (!m) m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  // youtube.com/embed/ID, /shorts/ID, /v/ID
  if (!m) m = url.match(/youtube\.com\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
  if (!m) return null;

  const videoId = m[1];
  return {
    url,
    image: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    type: "video.youtube",
    site: "YouTube",
    video: `https://www.youtube.com/embed/${videoId}`,
    fetched_at: new Date().toISOString(),
  };
}

// Parse OG / Twitter Card meta tags from HTML
function parseMeta(html: string, url: string): OGData {
  const get = (regex: RegExp): string | undefined => {
    const m = html.match(regex);
    return m ? m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'") : undefined;
  };

  // Try OG first, fall back to Twitter Card, then standard HTML
  const image =
    get(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i) ||
    get(/<meta\s+(?:property|name)="twitter:image"\s+content="([^"]+)"/i) ||
    get(/<meta\s+(?:property|name)="image"\s+content="([^"]+)"/i);

  const title =
    get(/<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i) ||
    get(/<meta\s+(?:property|name)="twitter:title"\s+content="([^"]+)"/i) ||
    get(/<title>([^<]+)<\/title>/i);

  const description =
    get(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i) ||
    get(/<meta\s+(?:property|name)="twitter:description"\s+content="([^"]+)"/i) ||
    get(/<meta\s+(?:property|name)="description"\s+content="([^"]+)"/i);

  const site = get(/<meta\s+(?:property|name)="og:site_name"\s+content="([^"]+)"/i);
  const type = get(/<meta\s+(?:property|name)="og:type"\s+content="([^"]+)"/i);
  const video = get(/<meta\s+(?:property|name)="og:video"\s+content="([^"]+)"/i);

  // Resolve relative image URLs
  let absImage = image;
  if (image && !image.startsWith("http")) {
    try {
      absImage = new URL(image, url).toString();
    } catch {}
  }

  // Favicon — use our own /api/favicon proxy so 404s don't leak to browser console
  let domain = "";
  try { domain = new URL(url).hostname; } catch {}
  const favicon = domain ? `/api/favicon?domain=${encodeURIComponent(domain)}` : undefined;

  return {
    url,
    image: absImage,
    title: title?.trim().slice(0, 200),
    description: description?.trim().slice(0, 300),
    site: site || domain,
    type,
    video,
    favicon,
    fetched_at: new Date().toISOString(),
  };
}

async function fetchOG(url: string): Promise<OGData> {
  // YouTube fast path — no fetch needed
  const yt = handleYouTube(url);
  if (yt) return yt;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      headers: {
        // Pretend to be browser — many sites refuse fetch with no UA
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { url, fetched_at: new Date().toISOString(), description: `(HTTP ${res.status})` };
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return { url, fetched_at: new Date().toISOString() };
    }
    // Only read first 200KB to find meta tags (saves bandwidth)
    const reader = res.body?.getReader();
    if (!reader) return { url, fetched_at: new Date().toISOString() };

    let html = "";
    const decoder = new TextDecoder();
    const MAX_BYTES = 200 * 1024;
    let total = 0;
    while (total < MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      total += value.byteLength;
      // Optimization: stop if </head> seen — meta tags all in head
      if (html.includes("</head>")) break;
    }
    try { await reader.cancel(); } catch {}

    return parseMeta(html, url);
  } catch (err: any) {
    return {
      url,
      fetched_at: new Date().toISOString(),
      description: `(fetch failed: ${err?.message || "unknown"})`,
    };
  }
}

// Transparent 1x1 PNG (43 bytes) — returned when no favicon found, prevents 404 noise
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const FAVICON_CACHE_DIR = join(process.env.HOME || "", "oracle", "ψ", "incubate", "yailai", "favicon-cache");
const FAVICON_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function fetchFaviconBytes(domain: string): Promise<Buffer | null> {
  const sources = [
    `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://${domain}/favicon.ico`,
    `https://${domain}/apple-touch-icon.png`,
  ];
  for (const src of sources) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(src, { signal: ctl.signal, redirect: "follow" });
      clearTimeout(t);
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (!/^image\//.test(ct) && !ct.includes("octet-stream")) continue;
      const ab = await res.arrayBuffer();
      if (ab.byteLength < 50) continue; // probably a 1x1 placeholder, skip
      return Buffer.from(ab);
    } catch {
      continue;
    }
  }
  return null;
}

export const ogApi = new Elysia();

ogApi.get("/favicon", async ({ query, set }) => {
  const domain = String((query as any).domain || "").toLowerCase().trim();
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) {
    set.status = 400;
    return "bad domain";
  }
  // Cache check
  try {
    mkdirSync(FAVICON_CACHE_DIR, { recursive: true });
  } catch {}
  const safe = domain.replace(/[^a-z0-9.-]/g, "_");
  const cacheFile = join(FAVICON_CACHE_DIR, `${safe}.bin`);
  const metaFile = join(FAVICON_CACHE_DIR, `${safe}.meta`);

  if (existsSync(cacheFile) && existsSync(metaFile)) {
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf-8")) as { ts: number; ct: string };
      if (Date.now() - meta.ts < FAVICON_TTL_MS) {
        set.headers["content-type"] = meta.ct || "image/x-icon";
        set.headers["cache-control"] = "public, max-age=2592000";
        return readFileSync(cacheFile);
      }
    } catch {}
  }

  const bytes = await fetchFaviconBytes(domain);
  const finalBytes = bytes || TRANSPARENT_PNG;
  const ct = bytes ? "image/x-icon" : "image/png";

  // Cache (even transparent fallback — avoid repeated upstream calls)
  try {
    writeFileSync(cacheFile, finalBytes);
    writeFileSync(metaFile, JSON.stringify({ ts: Date.now(), ct, hit: !!bytes }));
  } catch {}

  set.headers["content-type"] = ct;
  set.headers["cache-control"] = "public, max-age=2592000";
  return finalBytes;
}, {
  query: t.Object({
    domain: t.String(),
  }),
});

ogApi.get("/og", async ({ query, set }) => {
  const url = (query as any).url;
  if (!url || typeof url !== "string") {
    set.status = 400;
    return { error: "url query param required" };
  }
  if (!/^https?:\/\//.test(url)) {
    set.status = 400;
    return { error: "url must be http or https" };
  }

  // Try cache
  const cached = readCache(url);
  if (cached) {
    return { ...cached, cached: true };
  }

  // Fetch + cache
  const data = await fetchOG(url);
  writeCache(url, data);
  return { ...data, cached: false };
}, {
  query: t.Object({
    url: t.String(),
  }),
});
