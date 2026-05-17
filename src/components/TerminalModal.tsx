import { lazy, Suspense } from "react";
import type { AgentState } from "../lib/types";
import { useDevice } from "../hooks/useDevice";
import { OracleChatInput } from "./OracleChatInput";

const XTerminal = lazy(() => import("./XTerminal").then(m => ({ default: m.XTerminal })));

interface TerminalModalProps {
  agent: AgentState;
  send: (msg: object) => void;
  onClose: () => void;
  onNavigate: (dir: -1 | 1) => void;
  onSelectSibling: (agent: AgentState) => void;
  siblings: AgentState[];
}

function cleanName(name: string) {
  return name.replace(/-oracle$/, "").replace(/-/g, " ");
}

const STATUS_DOT: Record<string, string> = {
  busy: "#fdd835",
  ready: "#4caf50",
  idle: "#666",
};

export function TerminalModal({ agent, send, onClose, onNavigate, onSelectSibling, siblings }: TerminalModalProps) {
  const { isMobile } = useDevice();

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-[#0a0a0f]">
      <div className="flex h-full min-h-0 flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-white/[0.06] bg-[#0e0e18] px-2 py-2 sm:gap-3 sm:px-4">
          <button
            data-testid="terminal-modal-close"
            onClick={onClose}
            className="flex h-11 min-w-11 items-center justify-center rounded-xl px-3 text-[13px] font-mono font-bold text-white/60 active:scale-95 sm:hidden"
            style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.2)" }}
            title="Close"
          >
            ✕
          </button>

          <div className="hidden gap-1.5 shrink-0 sm:flex">
            <button onClick={onClose} className="w-3 h-3 rounded-full bg-[#ff5f57] hover:brightness-110 cursor-pointer" />
            <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
            <span className="w-3 h-3 rounded-full bg-[#28c840]" />
          </div>

          {/* Agent tab bar */}
          <div className="mx-1 flex min-w-0 flex-1 snap-x items-center gap-1 overflow-x-auto scrollbar-none sm:mx-2 sm:flex-none sm:gap-0.5">
            {siblings.map((s, i) => {
              const active = s.target === agent.target;
              return (
                <button
                  key={s.target}
                  data-testid={`terminal-agent-tab-${s.target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`}
                  onClick={() => onSelectSibling(s)}
                  className={`flex min-h-10 snap-start items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-mono whitespace-nowrap cursor-pointer transition-all sm:min-h-0 sm:rounded-md sm:px-2.5 sm:py-1 sm:text-[11px] ${
                    active
                      ? "bg-white/10 text-white/90"
                      : "text-white/35 hover:text-white/60 hover:bg-white/[0.04]"
                  }`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: STATUS_DOT[s.status] || "#555" }}
                  />
                  {i < 9 && (
                    <span className="text-[9px] text-white/20">{i + 1}</span>
                  )}
                  {cleanName(s.name)}
                </button>
              );
            })}
          </div>

          <div className="ml-auto hidden items-center gap-2 shrink-0 sm:flex">
            <button
              onClick={() => { if (confirm(`Restart ${agent.name}?`)) send({ type: "restart", target: agent.target }); }}
              className="px-2 py-0.5 rounded text-[10px] font-mono text-white/30 hover:text-orange-400 hover:bg-orange-400/10 border border-transparent hover:border-orange-400/20 transition-all cursor-pointer"
              title="Restart agent (Ctrl+C → relaunch)"
            >
              restart
            </button>
            {siblings.length > 1 && (
              <span className="text-[9px] text-white/20 tracking-wider">Alt+1-{Math.min(9, siblings.length)}</span>
            )}
            <button onClick={onClose} className="w-10 h-10 rounded-xl flex items-center justify-center text-2xl font-bold text-white/30 hover:text-white/70 hover:bg-red-500/15 active:scale-90 cursor-pointer transition-all" title="Close (Esc)">
              ✕
            </button>
          </div>
        </div>

        {/* Terminal — xterm.js via PTY WebSocket */}
        <div className="flex-1 overflow-hidden">
          <Suspense fallback={
            <div className="flex items-center justify-center h-full text-white/30 text-sm font-mono">
              Loading terminal...
            </div>
          }>
            <XTerminal
              target={agent.target}
              onClose={onClose}
              onNavigate={onNavigate}
              siblings={siblings}
              onSelectSibling={onSelectSibling}
              hideQuickCommandBar={isMobile}
            />
          </Suspense>
        </div>
        {isMobile && (
          <OracleChatInput
            agent={agent}
            target={agent.target}
            send={send}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
