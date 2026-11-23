// Phone UI helper "quick-reply" — free (no AI, no tokens) reply chips for agents that do not offer their own prompt
// suggestion (Codex, Gemini, …; Claude Code's own "💡 แนะนำ" still wins when it has one). Reads only the agent's LAST
// message: numbered / ก-ข-ค choices → "ข้อ 1"… · "ทาง ก" options → "ทาง ก"… · a closing yes/no question → "ทำเลย" ·
// "ยังไม่ต้อง" · mentions of "commit push" → "commit push". Pure function → tested in test/mobile-quick-reply.test.ts.
(() => {
  const w = typeof window !== "undefined" ? window : globalThis;
  if (!w.mawExt) return;
  const MAX = 4;
  const strip = t => String(t ?? "").replace(/```[\s\S]*?```/g, " ").replace(/[*_`>#]/g, "").replace(/\r/g, "");
  const short = (s, n = 26) => { s = s.replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  // a question somewhere in the last lines (Thai question words or "?")
  const QUESTION = /(ไหม|มั้ย|หรือยัง|หรือเปล่า|หรือไม่|ดีไหม|เอาไหน|ทางไหน|ข้อไหน|อันไหน|แบบไหน|\?)\s*(ครับ|คะ|ค่ะ|นะ)?\s*[.!…]*\s*$/;
  function quickReplies(text) {
    const lines = strip(text).split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const tail = lines.slice(-12), last = tail.slice(-3).join(" ");
    // asked = a question word anywhere in the last lines (choices are often named after the question: "เอาทางไหน, ทาง ข หรือ ค")
    const asks = /(ไหม|มั้ย|หรือยัง|หรือเปล่า|ดีไหม|เอาไหน|ทางไหน|ข้อไหน|อันไหน|แบบไหน|\?)/.test(tail.slice(-4).join(" ")) || /(เลือก|บอกได้|ตัดสิน|อนุญาต|เริ่มเลย|ทำต่อ)/.test(last);
    const out = [], add = (label, value) => { if (out.length < MAX && !out.some(o => o.value === value)) out.push({ label, value }); };
    // 1) numbered list (1. / 1) / ข้อ 1) or Thai letters (ก. ข. ค.) in the tail, at least 2 items, only when asked
    if (asks) {
      const num = [], thai = [];
      for (const l of tail) {
        let m = l.match(/^(?:ข้อ\s*)?(\d{1,2})[.)]\s+(.{2,})$/); if (m) num.push([m[1], m[2]]);
        m = l.match(/^([ก-ง])[.)]\s+(.{2,})$/); if (m) thai.push([m[1], m[2]]);
      }
      const list = num.length >= 2 ? num : thai.length >= 2 ? thai : [];
      for (const [k, t] of list) add(`${k} · ${short(t, 18)}`, `ข้อ ${k}`);
      // 2) "ทาง ก / ทาง ข" choices named in the text
      if (!list.length) {
        const ways = [...new Set([...strip(text).matchAll(/ทาง\s*([ก-ง])(?![ก-๙])/g)].map(m => m[1]))];
        if (ways.length >= 2) for (const k of ways) add(`ทาง ${k}`, `ทำ ทาง ${k}`);
      }
    }
    // 3) commit push offered
    if (/commit\s*push/i.test(tail.slice(-4).join(" "))) add("commit push", "commit push");
    // 4) a closing yes/no question → go / not now
    // (only for a yes/no question and only when no choice chips were found — "เอาข้อไหน" is not answered with "ทำเลย")
    const YESNO = /(ไหม|มั้ย|หรือยัง|หรือเปล่า|หรือไม่|\?)\s*(ครับ|คะ|ค่ะ|นะ)?\s*[.!…]*\s*$/;
    const choices = out.some(o => o.value !== "commit push");
    if (asks && !choices && YESNO.test(tail[tail.length - 1]) && !/(ไหน|อะไร|ยังไง|เท่าไ)/.test(tail[tail.length - 1])) { add("ทำเลย", "ทำเลย"); add("ยังไม่ต้อง", "ยังไม่ต้อง ไว้ก่อน"); }
    return out;
  }
  w.mawExt.quickReplies = quickReplies;
})();
