import { Hono } from "hono";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

/**
 * /yailai — Calendar UI สำหรับ digest ของป้าไล
 *
 *   /yailai            → calendar (current month) — click day → digest detail
 *   /yailai/YYYY-MM    → calendar for that month
 *   /yailai/YYYY-MM-DD → digest detail for that day (markdown render)
 */
export const yailaiView = new Hono();

const DIGEST_DIR = join(process.env.HOME || "", "oracle", "ψ", "incubate", "yailai", "digests");

function listAvailableDates(): Set<string> {
  try {
    if (!existsSync(DIGEST_DIR)) return new Set();
    const files = readdirSync(DIGEST_DIR);
    const dates = new Set<string>();
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m) dates.add(m[1]);
    }
    return dates;
  } catch {
    return new Set();
  }
}

function readDigest(date: string): string | null {
  try {
    const file = join(DIGEST_DIR, `${date}.md`);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

// Page chrome — header + dark theme + nav
function pageShell(title: string, bodyHtml: string, extraHead = ""): string {
  return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  ${extraHead}
  <style>
    :root {
      --bg: #0d1117;
      --bg-2: #161b22;
      --fg: #c9d1d9;
      --muted: #8b949e;
      --accent: #58a6ff;
      --accent-2: #79c0ff;
      --pink: #f778ba;
      --green: #3fb950;
      --border: #30363d;
      --shadow: 0 6px 20px rgba(0,0,0,0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1rem 4rem;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Sukhumvit Set", sans-serif;
      background: radial-gradient(at top, #11151c, #0a0d12 70%);
      color: var(--fg);
      line-height: 1.65;
      min-height: 100vh;
    }
    main { max-width: 980px; margin: 0 auto; padding: 0 1rem; }
    header.bar {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
      margin-bottom: 2rem;
      flex-wrap: wrap;
    }
    header.bar a { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
    header.bar a:hover { text-decoration: underline; }
    h1 {
      font-size: 1.8rem;
      margin: 0 0 1rem;
      color: #f0f6fc;
      display: flex;
      align-items: baseline;
      gap: 0.6rem;
    }
    h1 .sub { font-size: 0.9rem; color: var(--muted); font-weight: 400; }
    .month-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.5rem;
    }
    .month-nav a {
      color: var(--accent);
      text-decoration: none;
      padding: 0.4rem 0.9rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 0.9rem;
      transition: all 0.15s;
    }
    .month-nav a:hover { background: var(--bg-2); border-color: var(--accent); }
    .cal-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 8px;
    }
    .cal-head {
      text-align: center;
      font-size: 0.75rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      padding: 0.5rem 0;
    }
    .cal-cell {
      aspect-ratio: 1 / 1;
      border: 1px solid var(--border);
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      padding: 0.5rem;
      background: var(--bg-2);
      color: var(--muted);
      position: relative;
      text-decoration: none;
      transition: all 0.2s;
    }
    .cal-cell.empty { background: transparent; border-color: transparent; }
    .cal-cell.has-digest {
      color: var(--fg);
      border-color: rgba(247, 120, 186, 0.35);
      background: linear-gradient(135deg, rgba(247,120,186,0.08), var(--bg-2));
    }
    .cal-cell.has-digest:hover {
      border-color: var(--pink);
      transform: translateY(-2px);
      box-shadow: var(--shadow);
    }
    .cal-cell.today { outline: 2px solid var(--accent); outline-offset: -2px; }
    .cal-cell .day-num {
      font-size: 1.1rem;
      font-weight: 600;
      color: inherit;
    }
    .cal-cell.has-digest .digest-dot {
      position: absolute;
      bottom: 8px;
      right: 8px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--pink);
      box-shadow: 0 0 10px var(--pink);
    }
    .legend {
      display: flex;
      gap: 1.5rem;
      flex-wrap: wrap;
      margin-top: 2rem;
      font-size: 0.85rem;
      color: var(--muted);
    }
    .legend .dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
    }
    .legend .dot.pink { background: var(--pink); }
    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--muted);
    }
    .empty-state .emoji { font-size: 3rem; margin-bottom: 1rem; }

    /* digest detail */
    article#content { padding-bottom: 4rem; }
    article#content h1 { font-size: 1.8rem; border-bottom: 2px solid var(--border); padding-bottom: 0.3em; margin-top: 1.4em; }
    article#content h2 { font-size: 1.3rem; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; margin-top: 1.4em; color: var(--accent); }
    article#content h3 { font-size: 1.1rem; color: var(--pink); margin-top: 1.3em; }
    article#content a { color: var(--accent-2); }
    article#content code { background: var(--bg-2); padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; font-family: "SF Mono", Monaco, Consolas, monospace; }
    article#content pre { background: var(--bg-2); padding: 1rem; border-radius: 6px; overflow-x: auto; border: 1px solid var(--border); }
    article#content pre code { background: transparent; padding: 0; }
    article#content table { border-collapse: collapse; width: 100%; margin: 1rem 0; display: block; overflow-x: auto; }
    article#content th, article#content td { border: 1px solid var(--border); padding: 0.5rem 0.8rem; text-align: left; }
    article#content th { background: var(--bg-2); }
    article#content tr:nth-child(even) { background: rgba(22,27,34,0.5); }
    article#content blockquote { border-left: 4px solid var(--pink); padding: 0.3rem 1rem; color: var(--muted); margin: 1rem 0; background: var(--bg-2); }
    article#content ul, article#content ol { padding-left: 1.5rem; }
    article#content li { margin: 0.35em 0; }
    article#content hr { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }

    @media (max-width: 640px) {
      body { padding: 1rem 0.5rem 3rem; }
      h1 { font-size: 1.4rem; }
      .cal-cell { padding: 0.3rem; }
      .cal-cell .day-num { font-size: 0.9rem; }
    }
  </style>
</head>
<body>
  <main>
    <header class="bar">
      <a href="/#office">← Office</a>
      <a href="/info">Info</a>
      <a href="/plugins">Plugins</a>
      <a href="/skills">Skills</a>
      <a href="/yailai"><strong>ป้าไล</strong></a>
    </header>
    ${bodyHtml}
  </main>
</body>
</html>`;
}

function renderCalendar(year: number, month: number, dates: Set<string>): string {
  // month is 1-12
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const daysInMonth = lastDay.getDate();
  const startWeekday = firstDay.getDay(); // 0 = Sun

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const prevMonth = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
  const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthName = new Date(year, month - 1, 1).toLocaleString("en-US", { month: "long" });

  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const cells: string[] = [];
  // Weekday header
  for (const w of weekdays) cells.push(`<div class="cal-head">${w}</div>`);
  // Empty cells before day 1
  for (let i = 0; i < startWeekday; i++) cells.push(`<div class="cal-cell empty"></div>`);
  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const hasDigest = dates.has(dateStr);
    const isToday = dateStr === todayStr;
    const classes = ["cal-cell"];
    if (hasDigest) classes.push("has-digest");
    if (isToday) classes.push("today");

    if (hasDigest) {
      cells.push(`<a href="/yailai/${dateStr}" class="${classes.join(" ")}"><span class="day-num">${d}</span><span class="digest-dot"></span></a>`);
    } else {
      cells.push(`<div class="${classes.join(" ")}"><span class="day-num">${d}</span></div>`);
    }
  }

  const digestCount = Array.from(dates).filter(d => d.startsWith(`${year}-${String(month).padStart(2, "0")}`)).length;

  return `
    <h1>🏘️ ป้าไล Digests <span class="sub">— ปฏิทินข่าวรอบโลก</span></h1>
    <div class="month-nav">
      <a href="/yailai/${prevMonth}">← ${prevMonth}</a>
      <strong style="font-size:1.1rem;">${monthName} ${year}</strong>
      <a href="/yailai/${nextMonth}">${nextMonth} →</a>
    </div>
    <div class="cal-grid">${cells.join("")}</div>
    <div class="legend">
      <span><span class="dot pink"></span> มี digest (คลิกเพื่อดู)</span>
      <span>📅 พบ ${digestCount} digest ในเดือนนี้</span>
    </div>
    ${digestCount === 0 ? `
      <div class="empty-state">
        <div class="emoji">🌅</div>
        <p>เดือนนี้ป้าไลยังไม่มี digest — ลองเดือนอื่น หรือรอ cron 8:00 พรุ่งนี้</p>
      </div>` : ""}
  `;
}

function renderDigest(date: string, markdown: string, available: Set<string>): string {
  // Find prev/next day with digest
  const sorted = Array.from(available).sort();
  const idx = sorted.indexOf(date);
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
  const [y, m] = date.split("-");
  const monthBack = `${y}-${m}`;

  const escaped = markdown.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
  const head = `<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>`;

  return pageShell(
    `Digest ${date} — ป้าไล`,
    `
    <h1>🏘️ ป้าไล Digest <span class="sub">— ${date}</span></h1>
    <div class="month-nav">
      ${prev ? `<a href="/yailai/${prev}">← ${prev}</a>` : `<span></span>`}
      <a href="/yailai/${monthBack}">📅 ปฏิทิน</a>
      ${next ? `<a href="/yailai/${next}">${next} →</a>` : `<span></span>`}
    </div>
    <article id="content">Loading…</article>
    <script>
      const md = \`${escaped}\`;
      document.getElementById("content").innerHTML = marked.parse(md);
      // Open external links in new tab
      document.querySelectorAll("#content a").forEach(a => {
        const href = a.getAttribute("href") || "";
        if (href.startsWith("http")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
      });
    </script>
    `,
    head,
  );
}

// Routes

// /yailai → current month calendar
yailaiView.get("/", (c) => {
  const now = new Date();
  const dates = listAvailableDates();
  const body = renderCalendar(now.getFullYear(), now.getMonth() + 1, dates);
  return c.html(pageShell("ป้าไล Digests", body));
});

// /yailai/YYYY-MM → that month
// /yailai/YYYY-MM-DD → digest detail
yailaiView.get("/:slug", (c) => {
  const slug = c.req.param("slug");
  const monthM = slug.match(/^(\d{4})-(\d{2})$/);
  const dayM = slug.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dates = listAvailableDates();

  if (dayM) {
    const md = readDigest(slug);
    if (md === null) {
      const body = `
        <h1>🏘️ ป้าไล Digest <span class="sub">— ${slug}</span></h1>
        <div class="empty-state">
          <div class="emoji">🤷</div>
          <p>วันนี้ป้าไลไม่มี digest</p>
          <p><a href="/yailai">← กลับปฏิทิน</a></p>
        </div>`;
      c.status(404);
      return c.html(pageShell(`No digest — ${slug}`, body));
    }
    return c.html(renderDigest(slug, md, dates));
  }

  if (monthM) {
    const year = parseInt(monthM[1], 10);
    const month = parseInt(monthM[2], 10);
    if (month >= 1 && month <= 12) {
      const body = renderCalendar(year, month, dates);
      return c.html(pageShell(`ป้าไล Digests — ${slug}`, body));
    }
  }

  c.status(400);
  return c.html(pageShell("Bad request", `<p>Invalid date: ${slug}</p>`));
});
