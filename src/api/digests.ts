import { Elysia } from "elysia";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";

/**
 * JSON API for ป้าไล digests + Skills guide.
 *
 *   GET /api/digests          → { dates: ["2026-05-16", ...] }
 *   GET /api/digests/:date    → { date, markdown, exists }
 *   GET /api/skills-guide     → { markdown }
 *
 * Reads from $HOME/oracle/ψ/incubate/yailai/digests/ and $HOME/oracle/SKILLS-GUIDE.md.
 */

const DIGEST_DIR = join(process.env.HOME || "", "oracle", "ψ", "incubate", "yailai", "digests");
const SKILLS_GUIDE = join(process.env.HOME || "", "oracle", "SKILLS-GUIDE.md");

export const digestsApi = new Elysia();

digestsApi.get("/digests", () => {
  try {
    if (!existsSync(DIGEST_DIR)) return { dates: [] };
    const files = readdirSync(DIGEST_DIR);
    const dates: { date: string; size: number; mtime: string }[] = [];
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m) {
        const fp = join(DIGEST_DIR, f);
        const st = statSync(fp);
        dates.push({ date: m[1], size: st.size, mtime: st.mtime.toISOString() });
      }
    }
    dates.sort((a, b) => a.date.localeCompare(b.date));
    return { dates };
  } catch (err) {
    return { dates: [], error: String(err) };
  }
});

digestsApi.get("/digests/:date", ({ params, set }) => {
  const date = params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    set.status = 400;
    return { error: "invalid date format (expected YYYY-MM-DD)" };
  }
  try {
    const fp = join(DIGEST_DIR, `${date}.md`);
    if (!existsSync(fp)) {
      set.status = 404;
      return { date, exists: false, markdown: null };
    }
    const markdown = readFileSync(fp, "utf-8");
    const st = statSync(fp);
    return { date, exists: true, markdown, size: st.size, mtime: st.mtime.toISOString() };
  } catch (err) {
    set.status = 500;
    return { error: String(err) };
  }
});

digestsApi.get("/skills-guide", ({ set }) => {
  try {
    if (!existsSync(SKILLS_GUIDE)) {
      set.status = 404;
      return { exists: false, markdown: null };
    }
    const markdown = readFileSync(SKILLS_GUIDE, "utf-8");
    const st = statSync(SKILLS_GUIDE);
    return { exists: true, markdown, size: st.size, mtime: st.mtime.toISOString() };
  } catch (err) {
    set.status = 500;
    return { error: String(err) };
  }
});
