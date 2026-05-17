import { useEffect, useState, useMemo } from "react";
import { marked } from "marked";

interface DigestSummary { date: string; size: number; mtime: string; }
interface DigestDetail { date: string; exists: boolean; markdown: string | null; mtime?: string; }

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function YailaiView() {
  const [dates, setDates] = useState<DigestSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DigestDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [view, setView] = useState<{ year: number; month: number }>(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });

  // Fetch index
  useEffect(() => {
    fetch("/api/digests")
      .then(r => r.json())
      .then((d) => {
        const list = (d.dates || []) as DigestSummary[];
        setDates(list);
        // Auto-select latest
        if (list.length > 0) setSelected(list[list.length - 1].date);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  // Fetch detail when selected changes
  useEffect(() => {
    if (!selected) return;
    setLoadingDetail(true);
    fetch(`/api/digests/${selected}`)
      .then(r => r.json())
      .then((d) => setDetail(d))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoadingDetail(false));
  }, [selected]);

  // External link rewrite after render
  useEffect(() => {
    if (!detail?.markdown) return;
    requestAnimationFrame(() => {
      document.querySelectorAll<HTMLAnchorElement>(".prose-yailai a").forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (href.startsWith("http")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
      });
    });
  }, [detail]);

  const dateSet = useMemo(() => new Set((dates || []).map(d => d.date)), [dates]);
  const today = todayString();

  if (err) {
    return <div className="p-8 text-center text-red-400 font-mono">Error: {err}</div>;
  }
  if (!dates) {
    return <div className="p-8 text-center text-white/40 font-mono">Loading digests…</div>;
  }

  // Build calendar
  const { year, month } = view;
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const startWeekday = firstDay.getDay();
  const daysInMonth = lastDay.getDate();
  const cells: { dateStr: string | null; day?: number }[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push({ dateStr: null });
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ dateStr, day: d });
  }
  const monthName = new Date(year, month - 1, 1).toLocaleString("en-US", { month: "long" });
  const goPrev = () => setView(v => v.month === 1 ? { year: v.year - 1, month: 12 } : { ...v, month: v.month - 1 });
  const goNext = () => setView(v => v.month === 12 ? { year: v.year + 1, month: 1 } : { ...v, month: v.month + 1 });

  const monthDigestCount = Array.from(dateSet).filter(d => d.startsWith(`${year}-${String(month).padStart(2, "0")}`)).length;

  const sortedDates = [...dates].reverse();
  const recent = sortedDates.slice(0, 8);

  return (
    <div className="p-4 sm:p-6 max-w-[1100px] mx-auto min-w-0">
      <header className="mb-5 pb-3 border-b border-white/8">
        <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
          🏘️ ป้าไล Digest
        </h1>
        <p className="text-sm text-white/50 mt-1">
          ปฏิทินข่าวรอบโลก · {dates.length} digest ทั้งหมด
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(280px,1fr)_1.6fr] lg:gap-6">
        {/* Calendar + recent list */}
        <aside className="space-y-4 min-w-0">
          {/* Calendar */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <div className="flex items-center justify-between mb-3">
              <button onClick={goPrev} className="px-2 py-1 text-xs text-white/60 hover:text-white hover:bg-white/5 rounded transition">←</button>
              <div className="text-sm font-semibold text-white">{monthName} {year}</div>
              <button onClick={goNext} className="px-2 py-1 text-xs text-white/60 hover:text-white hover:bg-white/5 rounded transition">→</button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-wider text-white/40 mb-1">
              {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => <div key={d}>{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((c, i) => {
                if (!c.dateStr) return <div key={i} className="aspect-square" />;
                const hasDigest = dateSet.has(c.dateStr);
                const isToday = c.dateStr === today;
                const isSelected = c.dateStr === selected;
                const base = "aspect-square rounded-md flex items-center justify-center text-xs font-mono transition relative";
                let cls = base;
                if (isSelected) cls += " bg-pink-500/30 text-white border border-pink-400";
                else if (hasDigest) cls += " bg-pink-500/10 text-white hover:bg-pink-500/20 cursor-pointer border border-pink-400/30";
                else cls += " text-white/30 hover:bg-white/[0.04] cursor-pointer border border-white/[0.04]";
                if (isToday && !isSelected) cls += " ring-1 ring-cyan-400/60";
                return (
                  <button
                    key={i}
                    onClick={() => c.dateStr && setSelected(c.dateStr)}
                    className={cls}
                  >
                    {c.day}
                    {hasDigest && !isSelected && <span className="absolute bottom-0.5 right-0.5 w-1 h-1 rounded-full bg-pink-400" />}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 text-[10px] text-white/40 font-mono text-center">
              {monthDigestCount} digest ในเดือนนี้
            </div>
          </div>

          {/* Recent list */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02]">
            <div className="px-3 py-2 border-b border-white/8 text-xs uppercase tracking-wider text-white/40">
              ล่าสุด
            </div>
            <div className="max-h-[300px] overflow-auto">
              {recent.length === 0 && <div className="p-3 text-xs text-white/40 font-mono">ยังไม่มี digest</div>}
              {recent.map((d) => (
                <button
                  key={d.date}
                  onClick={() => setSelected(d.date)}
                  className={`w-full text-left px-3 py-2 border-b border-white/4 hover:bg-white/5 transition flex items-center justify-between ${selected === d.date ? "bg-pink-500/10" : ""}`}
                >
                  <div>
                    <div className="text-sm text-white font-mono">{d.date}</div>
                    <div className="text-[10px] text-white/40">{fmtBytes(d.size)}</div>
                  </div>
                  <span className="text-pink-400/60 text-xs">→</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* Digest detail */}
        <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-6 min-h-[60vh] min-w-0 overflow-hidden">
          {!selected && (
            <div className="text-center py-16 text-white/40">
              <div className="text-4xl mb-3">📅</div>
              <p>เลือกวันจากปฏิทินเพื่อดู digest</p>
            </div>
          )}
          {selected && loadingDetail && (
            <div className="text-center py-16 text-white/40 font-mono">Loading {selected}…</div>
          )}
          {selected && !loadingDetail && detail && !detail.exists && (
            <div className="text-center py-16 text-white/40">
              <div className="text-4xl mb-3">📭</div>
              <p>ไม่มี digest สำหรับวันนี้</p>
            </div>
          )}
          {selected && !loadingDetail && detail?.exists && detail.markdown && (
            <>
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/8">
                <div>
                  <div className="text-xs uppercase tracking-wider text-white/40">Digest</div>
                  <div className="text-lg font-mono text-pink-300">{detail.date}</div>
                </div>
                {detail.mtime && (
                  <div className="text-[10px] text-white/30 font-mono text-right">
                    updated<br/>{new Date(detail.mtime).toLocaleString()}
                  </div>
                )}
              </div>
              <article
                className="prose-yailai"
                dangerouslySetInnerHTML={{ __html: marked.parse(detail.markdown) as string }}
              />
            </>
          )}
        </section>
      </div>

      <style>{`
        .prose-yailai { color: rgba(255,255,255,0.85); line-height: 1.75; min-width: 0; word-break: normal; overflow-wrap: break-word; }
        .prose-yailai > :first-child { margin-top: 0; }
        .prose-yailai h1 { color: #fff; font-size: 1.4rem; font-weight: 700; margin: 1.8em 0 0.6em; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 0.4em; }
        .prose-yailai h2 { color: #22d3ee; font-size: 1.15rem; font-weight: 600; margin: 1.6em 0 0.5em; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 0.3em; }
        .prose-yailai h3 { color: #f778ba; font-size: 1rem; font-weight: 600; margin: 1.4em 0 0.4em; }
        .prose-yailai h4 { color: #a78bfa; font-size: 0.95rem; font-weight: 600; margin: 1.2em 0 0.3em; }
        .prose-yailai p { margin: 0.6em 0; word-break: normal; overflow-wrap: break-word; }
        .prose-yailai a { color: #79c0ff; text-decoration: none; border-bottom: 1px dotted rgba(121,192,255,0.3); }
        .prose-yailai a:hover { border-bottom-color: #79c0ff; }
        .prose-yailai code { background: rgba(255,255,255,0.06); padding: 0.15em 0.45em; border-radius: 4px; font-size: 0.88em; font-family: "SF Mono", Monaco, Consolas, monospace; color: #f0f6fc; }
        .prose-yailai pre { background: rgba(0,0,0,0.45); padding: 1rem; border-radius: 8px; overflow-x: auto; border: 1px solid rgba(255,255,255,0.08); margin: 1rem 0; }
        .prose-yailai pre code { background: transparent; padding: 0; }
        .prose-yailai ul, .prose-yailai ol { padding-left: 1.5rem; }
        .prose-yailai li { margin: 0.3em 0; word-break: normal; overflow-wrap: break-word; }
        .prose-yailai table { border-collapse: collapse; width: 100%; margin: 1rem 0; display: block; overflow-x: auto; font-size: 0.9rem; }
        .prose-yailai th, .prose-yailai td { border: 1px solid rgba(255,255,255,0.1); padding: 0.5rem 0.8rem; text-align: left; }
        .prose-yailai th { background: rgba(34,211,238,0.08); color: #22d3ee; font-weight: 600; }
        .prose-yailai tr:nth-child(even) td { background: rgba(255,255,255,0.02); }
        .prose-yailai blockquote { border-left: 3px solid #f778ba; padding: 0.4rem 1rem; color: rgba(255,255,255,0.65); margin: 1rem 0; background: rgba(247,120,186,0.06); border-radius: 0 6px 6px 0; }
        .prose-yailai hr { border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 2rem 0; }
        .prose-yailai strong { color: #fff; }
        @media (max-width: 760px) {
          .prose-yailai { font-size: 0.92rem; }
        }
      `}</style>
    </div>
  );
}
