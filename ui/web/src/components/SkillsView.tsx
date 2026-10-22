import { useEffect, useState } from "react";
import { marked } from "marked";

interface SkillsData {
  exists: boolean;
  markdown: string | null;
  mtime?: string;
}

export function SkillsView() {
  const [data, setData] = useState<SkillsData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/skills-guide")
      .then(r => r.json())
      .then((d) => setData(d))
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    // Open external links in new tab after render
    if (!data?.markdown) return;
    requestAnimationFrame(() => {
      document.querySelectorAll<HTMLAnchorElement>(".prose-skills a").forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (href.startsWith("http")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
      });
    });
  }, [data]);

  if (err) {
    return (
      <div className="p-8 text-center text-red-400 font-mono">
        Error loading skills guide: {err}
      </div>
    );
  }
  if (!data) {
    return <div className="p-8 text-center text-white/40 font-mono">Loading skills guide…</div>;
  }
  if (!data.exists || !data.markdown) {
    return (
      <div className="p-8 text-center text-white/60 font-mono">
        <div className="text-5xl mb-3">📚</div>
        <p>Skills guide ยังไม่ติดตั้ง</p>
        <p className="text-xs text-white/40 mt-2">
          สร้างที่ <code className="px-1.5 py-0.5 bg-white/10 rounded">~/oracle/SKILLS-GUIDE.md</code>
        </p>
      </div>
    );
  }

  const html = marked.parse(data.markdown) as string;

  return (
    <div className="p-4 sm:p-8 max-w-[1100px] mx-auto">
      <header className="mb-6 pb-4 border-b border-white/8">
        <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-1">
          📚 Skills Guide
        </h1>
        <p className="text-sm text-white/50">
          คู่มือสกิลทั้งหมดในระบบ — 261 skills · 60 agents · 74 commands
        </p>
        {data.mtime && (
          <p className="text-xs text-white/30 mt-1 font-mono">
            updated {new Date(data.mtime).toLocaleString()}
          </p>
        )}
      </header>
      <article
        className="prose-skills"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <style>{`
        .prose-skills {
          color: rgba(255,255,255,0.85);
          line-height: 1.7;
        }
        .prose-skills h1 { color: #fff; font-size: 1.5rem; font-weight: 700; margin: 1.8em 0 0.6em; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 0.4em; }
        .prose-skills h2 { color: #22d3ee; font-size: 1.2rem; font-weight: 600; margin: 1.6em 0 0.5em; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 0.3em; }
        .prose-skills h3 { color: #f778ba; font-size: 1rem; font-weight: 600; margin: 1.4em 0 0.4em; }
        .prose-skills h4 { color: #a78bfa; font-size: 0.95rem; font-weight: 600; margin: 1.2em 0 0.3em; }
        .prose-skills p { margin: 0.6em 0; }
        .prose-skills a { color: #79c0ff; text-decoration: none; border-bottom: 1px dotted rgba(121,192,255,0.3); }
        .prose-skills a:hover { border-bottom-color: #79c0ff; }
        .prose-skills code {
          background: rgba(255,255,255,0.06);
          padding: 0.15em 0.45em;
          border-radius: 4px;
          font-size: 0.88em;
          font-family: "SF Mono", Monaco, Consolas, monospace;
          color: #f0f6fc;
        }
        .prose-skills pre {
          background: rgba(0,0,0,0.45);
          padding: 1rem;
          border-radius: 8px;
          overflow-x: auto;
          border: 1px solid rgba(255,255,255,0.08);
          margin: 1rem 0;
        }
        .prose-skills pre code { background: transparent; padding: 0; }
        .prose-skills ul, .prose-skills ol { padding-left: 1.5rem; }
        .prose-skills li { margin: 0.3em 0; }
        .prose-skills table {
          border-collapse: collapse;
          width: 100%;
          margin: 1rem 0;
          display: block;
          overflow-x: auto;
          font-size: 0.9rem;
        }
        .prose-skills th, .prose-skills td {
          border: 1px solid rgba(255,255,255,0.1);
          padding: 0.5rem 0.8rem;
          text-align: left;
        }
        .prose-skills th {
          background: rgba(34,211,238,0.08);
          color: #22d3ee;
          font-weight: 600;
        }
        .prose-skills tr:nth-child(even) td { background: rgba(255,255,255,0.02); }
        .prose-skills blockquote {
          border-left: 3px solid #f778ba;
          padding: 0.4rem 1rem;
          color: rgba(255,255,255,0.6);
          margin: 1rem 0;
          background: rgba(247,120,186,0.06);
          border-radius: 0 6px 6px 0;
        }
        .prose-skills hr { border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 2rem 0; }
        .prose-skills strong { color: #fff; }
      `}</style>
    </div>
  );
}
