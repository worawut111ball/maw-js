import { Hono } from "hono";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * /skills — Render ~/oracle/SKILLS-GUIDE.md as a styled HTML page.
 *
 * Source of truth: $HOME/oracle/SKILLS-GUIDE.md
 * Falls back to a friendly "no guide installed" page if the file is missing.
 */
export const skillsView = new Hono();

skillsView.get("/", (c) => {
  const guidePath = join(process.env.HOME || "", "oracle", "SKILLS-GUIDE.md");
  let markdown = "";
  try {
    markdown = readFileSync(guidePath, "utf-8");
  } catch {
    markdown = "# Skills Guide ยังไม่ติดตั้ง\n\nไม่พบไฟล์ `~/oracle/SKILLS-GUIDE.md` — สร้างก่อนแล้ว refresh";
  }

  // Escape only what's necessary for embedding markdown in a JS string literal.
  // marked.js parses and sanitizes on the client.
  const escaped = markdown
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");

  return c.html(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Skills Guide — maw</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    :root {
      --bg: #0d1117;
      --fg: #c9d1d9;
      --muted: #8b949e;
      --accent: #58a6ff;
      --border: #30363d;
      --code-bg: #161b22;
      --table-stripe: #161b22;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1rem;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Sukhumvit Set", sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.65;
    }
    main {
      max-width: 980px;
      margin: 0 auto;
      padding: 0 1rem;
    }
    header.bar {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
      margin-bottom: 2rem;
      flex-wrap: wrap;
    }
    header.bar a {
      color: var(--accent);
      text-decoration: none;
      font-size: 0.9rem;
    }
    header.bar a:hover { text-decoration: underline; }
    h1, h2, h3, h4 {
      color: #f0f6fc;
      line-height: 1.25;
      margin-top: 1.6em;
      margin-bottom: 0.6em;
    }
    h1 { font-size: 2rem; border-bottom: 2px solid var(--border); padding-bottom: 0.3em; }
    h2 { font-size: 1.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
    h3 { font-size: 1.2rem; color: var(--accent); }
    a { color: var(--accent); }
    code {
      background: var(--code-bg);
      padding: 0.15em 0.4em;
      border-radius: 4px;
      font-size: 0.9em;
      font-family: "SF Mono", Monaco, Consolas, monospace;
    }
    pre {
      background: var(--code-bg);
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      border: 1px solid var(--border);
    }
    pre code { background: transparent; padding: 0; }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1rem 0;
      display: block;
      overflow-x: auto;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 0.5rem 0.8rem;
      text-align: left;
    }
    th { background: var(--code-bg); }
    tr:nth-child(even) { background: var(--table-stripe); }
    ul, ol { padding-left: 1.5rem; }
    li { margin: 0.3em 0; }
    blockquote {
      border-left: 4px solid var(--accent);
      padding: 0.3rem 1rem;
      color: var(--muted);
      margin: 1rem 0;
      background: var(--code-bg);
    }
    hr { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
    @media (max-width: 640px) {
      body { padding: 1rem 0.5rem; }
      h1 { font-size: 1.5rem; }
      h2 { font-size: 1.25rem; }
      th, td { padding: 0.3rem 0.5rem; font-size: 0.9em; }
    }
  </style>
</head>
<body>
  <main>
    <header class="bar">
      <a href="/#office">← Office</a>
      <a href="/info">Info</a>
      <a href="/plugins">Plugins</a>
      <a href="/skills"><strong>Skills</strong></a>
    </header>
    <article id="content">Loading…</article>
  </main>
  <script>
    const md = \`${escaped}\`;
    document.getElementById("content").innerHTML = marked.parse(md);
  </script>
</body>
</html>`);
});
