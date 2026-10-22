import { Elysia} from "elysia";
import { closeSync, openSync, readdirSync, readSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

export const costsApi = new Elysia();

// Cost per million tokens (USD)
const COST_PER_MTOK: Record<string, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.25, output: 1.25 },
};

function modelTier(model: string): string {
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return "sonnet"; // default
}

function agentNameFromDir(dir: string): string {
  // Dir like "-home-nat-Code-github-com-laris-co-neo-oracle"
  // Extract the last meaningful segment(s)
  const parts = dir.replace(/^-/, "").split("-");
  // Find github-com pattern and take org/repo after it
  const ghIdx = parts.indexOf("github");
  if (ghIdx >= 0 && parts[ghIdx + 1] === "com" && parts.length > ghIdx + 3) {
    return parts.slice(ghIdx + 2).join("-");
  }
  // Fallback: last 2 segments
  return parts.slice(-2).join("-");
}

interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  turns: number;
  model: string;
  lastTimestamp: string;
}

// Transcripts grow to hundreds of MB, and this used to re-read every one of them in full, synchronously, on each
// request — freezing the whole server (WebSockets, the phone app) for ~8 s. Now each file is read once, in chunks
// that yield to the event loop, and afterwards only the bytes appended since the last call.
interface ScanState { offset: number; rest: Buffer; u: SessionUsage; busy: Promise<void> | null }
const scanCache = new Map<string, ScanState>();
const SCAN_CHUNK = 8 << 20;
const emptyUsage = (): SessionUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, turns: 0, model: "", lastTimestamp: "" });

function addLine(u: SessionUsage, line: string): void {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;   // cheap filter before JSON.parse
  let obj: any;
  try { obj = JSON.parse(line); } catch { return; }
  if (obj.type !== "assistant" || !obj.message?.usage) return;
  const m = obj.message.usage;
  u.inputTokens += m.input_tokens || 0;
  u.outputTokens += m.output_tokens || 0;
  u.cacheReadTokens += m.cache_read_input_tokens || 0;
  u.cacheCreateTokens += m.cache_creation_input_tokens || 0;
  u.turns++;
  if (obj.message.model && !u.model) u.model = obj.message.model;
  if (obj.timestamp) u.lastTimestamp = obj.timestamp;
}

async function readNew(filePath: string, st: ScanState, size: number): Promise<void> {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(Math.min(SCAN_CHUNK, size - st.offset));
    while (st.offset < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - st.offset), st.offset);
      if (n <= 0) break;
      st.offset += n;
      const data = st.rest.length ? Buffer.concat([st.rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      const cut = data.lastIndexOf(10);                       // whole lines only — never split a UTF-8 char
      if (cut < 0) { st.rest = Buffer.from(data); continue; }
      for (const line of data.subarray(0, cut).toString("utf-8").split("\n")) if (line) addLine(st.u, line);
      st.rest = Buffer.from(data.subarray(cut + 1));
      await new Promise(r => setImmediate(r));               // let WebSockets and other requests run
    }
  } finally { closeSync(fd); }
}

async function scanSession(filePath: string): Promise<SessionUsage | null> {
  let size: number;
  try { size = statSync(filePath).size; } catch { return null; }
  let st = scanCache.get(filePath);
  if (st?.busy) await st.busy;
  st = scanCache.get(filePath);
  if (!st || size < st.offset) { st = { offset: 0, rest: Buffer.alloc(0), u: emptyUsage(), busy: null }; scanCache.set(filePath, st); }
  if (size > st.offset) {
    const s = st;
    s.busy = readNew(filePath, s, size).catch(() => {}).finally(() => { s.busy = null; });
    await s.busy;
  }
  return st.u.turns ? { ...st.u } : null;
}

function estimateCost(usage: SessionUsage): number {
  const tier = modelTier(usage.model);
  const rates = COST_PER_MTOK[tier] || COST_PER_MTOK.sonnet;
  const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
  return (totalInput / 1_000_000) * rates.input + (usage.outputTokens / 1_000_000) * rates.output;
}

// ---------------------------------------------------------------------------
// Helpers for /costs/daily
// ---------------------------------------------------------------------------

/** Convert an ISO timestamp string to a local-TZ "YYYY-MM-DD" string. */
function localDateStr(isoTs: string): string {
  const d = new Date(isoTs);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Generate N date strings (local TZ) ending today (inclusive), oldest first.
 * Uses UTC arithmetic then converts to local date — DST-safe for display.
 */
function makeBuckets(n: number): string[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today.getTime() - (n - 1 - i) * 86_400_000);
    return localDateStr(d.toISOString());
  });
}

costsApi.get("/costs/daily", async ({ query, set }) => {
  const days = Number(query.days ?? 7);
  if (isNaN(days) || days < 1 || days > 365) {
    set.status = 400;
    return { error: "days must be 1–365" };
  }

  const buckets = makeBuckets(days);
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

  const projectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir).filter((d) => {
      try { return statSync(join(projectsDir, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    set.status = 500;
    return { error: "Cannot read ~/.claude/projects/" };
  }

  // agentName → { costs: number[], hadActivity: boolean[] }
  const agentDailyMap = new Map<string, { costs: number[]; hadActivity: boolean[] }>();

  for (const dir of dirs) {
    const dirPath = join(projectsDir, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }

    if (files.length === 0) continue;
    const agentName = agentNameFromDir(dir);

    if (!agentDailyMap.has(agentName)) {
      agentDailyMap.set(agentName, {
        costs: Array(days).fill(0),
        hadActivity: Array(days).fill(false),
      });
    }

    const entry = agentDailyMap.get(agentName)!;

    for (const file of files) {
      const usage = await scanSession(join(dirPath, file));
      if (!usage || !usage.lastTimestamp) continue;

      const dateStr = localDateStr(usage.lastTimestamp);
      const idx = bucketIndex.get(dateStr);
      if (idx === undefined) continue; // outside the window

      entry.costs[idx] += estimateCost(usage);
      entry.hadActivity[idx] = true;
    }
  }

  const agents = [...agentDailyMap.entries()]
    .filter(([, d]) => d.costs.reduce((s, v) => s + v, 0) > 0)
    .map(([name, d]) => ({
      name,
      dailyCosts: d.costs,
      totalCost: d.costs.reduce((s, v) => s + v, 0),
      hadActivity: d.hadActivity,
    }))
    .sort((a, b) => b.totalCost - a.totalCost);

  const totalCost = agents.reduce((s, a) => s + a.totalCost, 0);
  return { window: days, buckets, agents, total: { cost: totalCost, agents: agents.length } };
});

costsApi.get("/costs", async ({ set }) => {
  const projectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir).filter((d) => {
      try { return statSync(join(projectsDir, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    set.status = 500; return { error: "Cannot read ~/.claude/projects/" };
  }

  const agents: Record<string, {
    name: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    totalTokens: number;
    estimatedCost: number;
    sessions: number;
    turns: number;
    models: Record<string, number>;
    lastActive: string;
  }> = {};

  for (const dir of dirs) {
    const dirPath = join(projectsDir, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }

    if (files.length === 0) continue;
    const agentName = agentNameFromDir(dir);

    if (!agents[agentName]) {
      agents[agentName] = {
        name: agentName,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
        sessions: 0,
        turns: 0,
        models: {},
        lastActive: "",
      };
    }

    for (const file of files) {
      const usage = await scanSession(join(dirPath, file));
      if (!usage) continue;

      const a = agents[agentName];
      a.inputTokens += usage.inputTokens;
      a.outputTokens += usage.outputTokens;
      a.cacheReadTokens += usage.cacheReadTokens;
      a.cacheCreateTokens += usage.cacheCreateTokens;
      a.totalTokens += usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
      a.estimatedCost += estimateCost(usage);
      a.sessions++;
      a.turns += usage.turns;

      const tier = modelTier(usage.model);
      a.models[tier] = (a.models[tier] || 0) + usage.turns;

      if (usage.lastTimestamp > a.lastActive) a.lastActive = usage.lastTimestamp;
    }
  }

  const agentList = Object.values(agents)
    .filter((a) => a.sessions > 0)
    .sort((a, b) => b.estimatedCost - a.estimatedCost);

  const total = {
    tokens: agentList.reduce((s, a) => s + a.totalTokens, 0),
    cost: agentList.reduce((s, a) => s + a.estimatedCost, 0),
    sessions: agentList.reduce((s, a) => s + a.sessions, 0),
    agents: agentList.length,
  };

  return { agents: agentList, total };
});
