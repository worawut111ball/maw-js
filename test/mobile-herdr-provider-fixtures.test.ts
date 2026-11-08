import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "fixtures/herdr-provider");
const fixture = (name: string): any => JSON.parse(readFileSync(join(root, name + ".json"), "utf8"));
const pinned = fixture("protocol22.schema");
// Interpret upstream structural keywords rather than the provider's parser/types.
// Format annotations are not a full JSON Schema implementation.
function valid(value: any, s: any): boolean {
  if (s.$ref) return valid(value, s.$ref.slice(2).split("/").reduce((x: any, k: string) => x[k], pinned));
  if (s.oneOf && s.oneOf.filter((x: any) => valid(value, x)).length !== 1) return false;
  if (s.anyOf && !s.anyOf.some((x: any) => valid(value, x))) return false;
  if ("const" in s && value !== s.const) return false;
  if (s.enum && !s.enum.includes(value)) return false;
  if (s.type && !(Array.isArray(s.type) ? s.type : [s.type]).some((t: string) =>
    t === "null" ? value === null : t === "array" ? Array.isArray(value) : t === "integer" ? Number.isInteger(value) :
    t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === t)) return false;
  if (typeof value === "number" && ((s.minimum !== undefined && value < s.minimum) || (s.maximum !== undefined && value > s.maximum))) return false;
  if (typeof value === "string" && s.pattern && !new RegExp(s.pattern).test(value)) return false;
  if (Array.isArray(value) && s.items && !value.every(x => valid(x, s.items))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (s.required?.some((k: string) => !Object.hasOwn(value, k))) return false;
    if (s.maxProperties !== undefined && Object.keys(value).length > s.maxProperties) return false;
    for (const [k, x] of Object.entries(value)) {
      if (s.propertyNames && !valid(k, s.propertyNames)) return false;
      const property = s.properties?.[k] ?? s.additionalProperties;
      if (property === false || (property && !valid(x, property))) return false;
    }
  }
  return true;
}

describe("synthetic Herdr fixture contracts, independent of runtime", () => {
  test("protocol22 snapshot and error envelopes satisfy the pinned upstream structure", () => {
    expect(pinned.protocol).toBe(22);
    for (const name of ["snapshot-team", "snapshot-empty", "snapshot-shells", "snapshot-replaced", "snapshot-other-agent"])
      expect(valid(fixture(name), pinned.schemas.success_response)).toBe(true);
    for (const name of ["error-unavailable", "error-agent-not-found"])
      expect(valid(fixture(name), pinned.schemas.error_response)).toBe(true);
  });
  test("validator detects required native metadata/types rather than accepting any JSON", () => {
    const snapshot = fixture("snapshot-team");
    delete snapshot.result.snapshot.panes[0].terminal_id;
    expect(valid(snapshot, pinned.schemas.success_response)).toBe(false);
    const native = fixture("snapshot-team");
    native.result.snapshot.agents[0].agent_session.kind = "invented-kind";
    expect(valid(native, pinned.schemas.success_response)).toBe(false);
  });
  test("team contains four linked identities in two tabs sharing cwd but different conversations", () => {
    const s = fixture("snapshot-team").result.snapshot;
    expect(s.panes).toHaveLength(4);
    expect(new Set(s.panes.map((p: any) => p.tab_id)).size).toBe(2);
    expect(new Set(s.panes.map((p: any) => p.cwd)).size).toBe(1);
    expect(new Set(s.panes.map((p: any) => p.agent_session.value)).size).toBe(4);
    for (const p of s.panes) {
      expect(s.tabs.some((t: any) => t.tab_id === p.tab_id && t.workspace_id === p.workspace_id)).toBe(true);
      expect(s.agents.find((a: any) => a.pane_id === p.pane_id).terminal_id).toBe(p.terminal_id);
    }
  });
  test("replacement keeps label/pane/cwd while changing generation evidence", () => {
    const old = fixture("snapshot-team").result.snapshot.panes[0];
    const next = fixture("snapshot-replaced").result.snapshot.panes[0];
    expect(next.pane_id).toBe(old.pane_id);
    expect(next.cwd).toBe(old.cwd);
    expect(next.terminal_id).not.toBe(old.terminal_id);
    expect(next.agent_session.value).not.toBe(old.agent_session.value);
  });
  test("native transcripts remain distinct from terminal snapshots and each other", () => {
    const rows = (name: string) => readFileSync(join(root, name), "utf8").trim().split("\n").map(x => JSON.parse(x));
    expect(rows("claude-native.jsonl").at(-1).message.content[0].text).toContain("Claude");
    expect(rows("codex-native.jsonl").at(-1).payload.content[0].text).toContain("Codex");
  });
});
