// Phone UI helper "mind-route" — pure functions for "📤 ส่งให้ห้อง agent" in the Mind Mail sheet (ext/mind.js uses them).
// rankRooms(projects, mail, memory) → agent rooms (claude/codex, not ended) ranked best-first with a reason; the top ones are
//   shown as "แนะนำ". Signals: the room this sender's mail went to last time (memory) · project/room names found in the mail ·
//   live rooms over sleeping ones. No network, no DOM → tested in test/mobile-mind-route.test.ts.
// forwardText(mail) → the chat message typed into the chosen room (≤ 8000 chars, the /rooms/:ws/:room/send limit).
(() => {
  const w = typeof window !== "undefined" ? window : globalThis;
  if (!w.mawExt) return;
  const TEXT_MAX = 8000;
  const AGENTS = ["claude", "codex"];
  // words too common in mail/room names to say anything about where a mail belongs
  const STOP = new Set(["the", "and", "for", "from", "with", "this", "that", "local", "main", "develop", "claude", "codex",
    "code", "terminal", "agent", "artron", "oracle", "team", "tmux", "folder", "production", "prod", "update", "fix", "test", "chat", "new", "เรื่อง", "ตอบ", "ถึง", "จาก"]);
  // nicknames people write in mail for the team rooms (title contains the key → these count as that room's name too)
  const ALIAS = { team1: ["ไอ้แดง", "ทีม 1", "ทีม1"], team2: ["ทีม 2", "ทีม2"], team3: ["ยายไล", "ทีม 3", "ทีม3"] };
  const norm = s => String(s ?? "").toLowerCase();
  // name → probe words: latin/number words ≥ 3 chars (split on - _ . space /), and the whole Thai name when it has Thai
  function probes(name) {
    const s = norm(name), out = new Set();
    for (const t of s.split(/[^a-z0-9ก-๙]+/)) if (/[a-z0-9]/.test(t) ? t.length >= 4 : t.length >= 5) if (!STOP.has(t)) out.add(t);
    for (const [k, v] of Object.entries(ALIAS)) if (s.includes(k)) v.forEach(a => out.add(a));
    const thai = s.replace(/[^ก-๙\s]/g, " ").replace(/\s+/g, " ").trim();
    if (thai.length >= 5 && !STOP.has(thai)) out.add(thai);
    return [...out];
  }
  // latin/number probes match whole words only ("cli" must not hit "client"); Thai has no spaces → plain substring
  const hits = (text, t) => /[a-z0-9]/.test(t) ? new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(text) : text.includes(t);
  const live = st => !["asleep", "ended"].includes(String(st || ""));
  function rankRooms(projects, mail, memory) {
    const text = norm([mail?.subject, mail?.body, mail?.from].join("\n"));
    const remembered = memory && mail?.from ? memory[norm(mail.from)] : null;
    const rows = [];
    for (const p of Array.isArray(projects) ? projects : []) for (const ws of p.workspaces || []) for (const r of ws.rooms || []) {
      if (!AGENTS.includes(r.agent) || r.status === "ended") continue;
      let score = 0; const why = [];
      if (remembered && remembered.ws === ws.id && remembered.room === r.id) { score += 100; why.push(`เคยส่งเรื่องจาก ${mail.from} มาห้องนี้`); }
      const hitP = probes(p.name).filter(t => hits(text, t));
      if (hitP.length) { score += 20 * hitP.length; why.push(`จดหมายพูดถึง ${p.name}`); }
      const hitR = probes(r.title).filter(t => hits(text, t) && !hitP.includes(t));
      if (hitR.length) { score += 8 * hitR.length; why.push(`ตรงชื่อห้อง "${r.title}"`); }
      if (live(r.status)) score += 3; else why.push("ห้องหลับอยู่ (ส่งแล้วต้องรอปลุก)");
      if (r.status === "working") score -= 2;            // busy now — a quieter room answers sooner
      rows.push({ ws: ws.id, room: r.id, project: p.name, title: r.title || r.agent, agent: r.agent, status: r.status || "",
        generation: r.generation, source: p.source || "", score, why });
    }
    return rows.sort((a, b) => b.score - a.score || a.project.localeCompare(b.project) || a.title.localeCompare(b.title));
  }
  /** How many of the ranked rooms earn the "แนะนำ" badge: those with a real signal (memory or a name hit), at most 3. */
  const suggestedCount = ranked => Math.min(3, ranked.filter(r => r.score >= 8).length);
  function forwardText(mail) {
    const head = `📬 จดหมายจาก Mind Mail Box — ${mail?.from || "?"}${mail?.fromOwner ? ` (${mail.fromOwner})` : ""} ถึง ${mail?.to || "?"}\nหัวข้อ: ${mail?.subject || "(ไม่มีหัวข้อ)"}\n\n`;
    const tail = `\n\n---\n(ส่งต่อจากหน้า Mail ของ maw · Mind id ${mail?.id || "?"}) ช่วยดูและทำตามเรื่องนี้ แล้วสรุปให้ผมในแชทนี้`;
    let body = String(mail?.body ?? "");
    const room = TEXT_MAX - head.length - tail.length;
    if (body.length > room) body = body.slice(0, Math.max(0, room - 40)) + "\n…(ตัดท้าย · อ่านฉบับเต็มใน Mind)";
    return head + body + tail;
  }
  w.mawExt.mindRoute = { rankRooms, suggestedCount, forwardText, TEXT_MAX };
})();
