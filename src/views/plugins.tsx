/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import type { PluginSystem } from "../plugins";

export function pluginsView(plugins: PluginSystem) {
  const view = new Hono();

  view.get("/", (c) => {
    const s = plugins.stats();
    const up = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000);
    const upStr = up > 3600 ? `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`
      : up > 60 ? `${Math.floor(up / 60)}m ${up % 60}s` : `${up}s`;

    return c.html(
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Plugins — maw</title>
          <style>{css}</style>
        </head>
        <body>
          <main class="shell">
            <header class="topbar">
              <div>
                <p class="eyebrow">maw runtime</p>
                <h1>Plugin System v2</h1>
              </div>
              <div class="refresh">refreshes every 5s</div>
            </header>

            <section class="stats" aria-label="Plugin runtime stats">
              <div class="stat"><div class="l">Plugins</div><div class="n">{s.plugins.length}</div></div>
              <div class="stat"><div class="l">Events</div><div class="n pulse">{s.totalEvents}</div></div>
              <div class="stat"><div class="l">Errors</div><div class={s.totalErrors > 0 ? "n err" : "n ok"}>{s.totalErrors}</div></div>
              <div class="stat"><div class="l">Gated</div><div class={s.gated > 0 ? "n warn" : "n ok"}>{s.gated || 0}</div></div>
              <div class="stat"><div class="l">Uptime</div><div class="n">{upStr}</div></div>
            </section>

            <section class="panel">
              <div class="panel-head">
                <h2>Loaded Plugins</h2>
                <span>{s.plugins.length} total</span>
              </div>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>Plugin</th><th>Type</th><th>Events</th><th>Errors</th><th>Last Event</th><th>Loaded</th></tr>
                  </thead>
                  <tbody>
                    {s.plugins.map(p => (
                      <tr>
                        <td><strong>{p.name}</strong></td>
                        <td><span class={`tag ${p.type}`}>{p.type}</span></td>
                        <td>{p.events}</td>
                        <td class={p.errors > 0 ? "err" : "ok"}>{p.errors}</td>
                        <td class="muted">{p.lastEvent || "none"}</td>
                        <td class="muted">{new Date(p.loadedAt).toLocaleTimeString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section class="hooks">
              {[
                { label: "Gates", detail: "Phase 0", data: s.gates || {} },
                { label: "Filters", detail: "Phase 1", data: s.filters || {} },
                { label: "Handlers", detail: "Phase 2", data: s.handlers || {} },
                { label: "Lates", detail: "Phase 3", data: s.lates || {} },
              ].filter(p => Object.keys(p.data).length > 0).map(phase => (
                <div class="hook">
                  <div class="hook-title">
                    <h3>{phase.label}</h3>
                    <span>{phase.detail}</span>
                  </div>
                  <div class="hook-list">
                    {Object.entries(phase.data).map(([k, v]) => (
                      <div class="hook-item"><span>{k}</span><span class="count">&times;{v as number}</span></div>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          </main>

          <script>{`setInterval(()=>location.reload(),5000)`}</script>
        </body>
      </html>
    );
  });

  return view;
}

const css = `
:root{color-scheme:dark;--bg:#0b0d10;--panel:#14171d;--panel-2:#101318;--line:#2a3038;--text:#edf1f5;--muted:#8d99a8;--cyan:#38d5c8;--amber:#f0b65a;--rose:#ff6b8a;--green:#63d48a;--blue:#7aa7ff}
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.shell{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:28px 0 40px}
.topbar{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:20px}
.eyebrow{color:var(--cyan);font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}
h1{font-size:28px;line-height:1.1;margin-top:6px}
.refresh{color:var(--muted);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:18px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;min-width:0}
.stat .n{font:700 26px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat .l{font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);text-transform:uppercase;margin-bottom:10px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin-bottom:18px;overflow:hidden}
.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}
h2{font-size:15px}.panel-head span,.muted{color:var(--muted)}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:760px}
th{text-align:left;font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);text-transform:uppercase;padding:10px 16px;background:var(--panel-2)}
td{padding:11px 16px;border-top:1px solid var(--line);vertical-align:middle}
tbody tr:hover{background:#1b2028}
.tag{display:inline-flex;align-items:center;min-height:22px;padding:3px 8px;border-radius:4px;font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
.ts{background:#173b38;color:var(--cyan)}.wasm-shared{background:#2a2442;color:#b89cff}.wasm-wasi{background:#3d2230;color:#ff9ab0}.js{background:#3f351d;color:#ffd36f}
.hooks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.hook{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;min-width:0}
.hook-title{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}
.hook h3{font-size:14px}.hook-title span{color:var(--muted);font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
.hook-list{display:flex;flex-wrap:wrap;gap:8px}
.hook-item{display:inline-flex;align-items:center;gap:8px;max-width:100%;background:var(--panel-2);border:1px solid var(--line);padding:5px 9px;border-radius:4px;font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}
.hook-item span:first-child{overflow:hidden;text-overflow:ellipsis}
.count{color:var(--amber);font-weight:700}
.err{color:var(--rose)}.ok{color:var(--green)}.warn{color:var(--amber)}
.pulse{animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.65}}
@media (max-width:760px){.shell{width:min(100% - 24px,1180px);padding-top:18px}.topbar{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.hooks{grid-template-columns:1fr}h1{font-size:24px}}
@media (max-width:420px){.stats{grid-template-columns:1fr}.stat .n{font-size:23px}}
`;
