// Feature packs for the phone UI — see PLAN-maw-mobile.md §9. Each adds routes under /mobile.
import type { HerdrRuntime } from "../herdr/runtime";
import { readScreen, pressKey, roomChannel } from "./ctx";
import { allowedDir } from "../api";
import { mount as permissions } from "./permissions";
import { mount as modes } from "./modes";
import { mount as activity } from "./activity";
import { mount as resume } from "./resume";
import { mount as context } from "./context";
import { mount as superset } from "./superset";
import { mount as travel } from "./travel";
import { mount as autostart } from "./autostart";
import { mount as herdr, type HerdrFeatureOptions } from "./herdr";
import { productionLifecycle } from "../herdr/production";
import { mount as ports } from "./ports";
import { mount as retro } from "./retro";
import { mount as prs } from "./prs";
import { mount as mind } from "./mind";
import { mount as docs } from "./docs";
import { mount as vault } from "./vault";
import { mount as continuity, type ContinuityFeatureOptions } from "./continuity";

export function mountFeatures(app: any, options: { herdr?: HerdrRuntime; test?: boolean; continuity?: ContinuityFeatureOptions } = {}): void {
  continuity(app, options.continuity);
  permissions(app, options.test ? { readScreen: (ch, lines) => ch.kind === "herdr" ? options.herdr!.screen(ch, lines) : readScreen(ch, lines), pressKey, roomChannel, herdr: options.herdr } : { readScreen, pressKey, roomChannel, herdr: options.herdr });
  let lifecycleOptions: HerdrFeatureOptions | undefined;
  if (!options.test && process.env.NODE_ENV !== "test" && !process.env.MAW_TEST_MODE) {
    const host = productionLifecycle(allowedDir), runtime = options.herdr!;
    lifecycleOptions = {
      lifecycle: host.lifecycle,
      resolve: async (ws, room, generation) => {
        await runtime.refresh();
        const ch = runtime.resolve(ws, room);
        if (!ch || ch.generation !== generation) throw Object.assign(new Error("agent_changed"), { code: "agent_changed", status: 409 });
        const snapshot = await host.snapshot();
        const current = runtime.resolve(ws, room);
        if (!current || current.generation !== generation) throw Object.assign(new Error("agent_changed"), { code: "agent_changed", status: 409 });
        const binding = snapshot.panes.find(p => p.workspaceId === ch.workspaceId && p.paneId === ch.paneId && p.terminalId === ch.terminalId);
        if (!binding) throw Object.assign(new Error("agent_changed"), { code: "agent_changed", status: 409 });
        return binding;
      },
      deliveryStatus: (id, ws, room, generation) => {
        const ch = runtime.resolve(ws, room);
        if (!ch || ch.generation !== generation) return { state: "unknown", ok: false };
        return runtime.deliveryStatus(id, ch);
      },
    };
    // Registration only; no server is started. Legacy autostart is deliberately not mounted.
    // Delay initialization so a broken legacy file is reported by status instead of aborting API construction.
    const timer = setTimeout(() => {
      try { host.lifecycle.startReadiness((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); }); }
      catch { /* status endpoints expose migration/store errors; never launch on failure */ }
    }, 1000); timer.unref?.();
  }
  herdr(app, lifecycleOptions);
  for (const m of [modes, activity, resume, context, superset, travel, autostart, ports, retro, prs, mind, docs, vault]) m(app);
}
