import { memo, useMemo, useRef, useEffect, useState } from "react";
import { roomStyle, agentColor } from "../lib/constants";
import { AgentAvatar } from "./AgentAvatar";
import type { Session, AgentState } from "../lib/types";

interface OrbitalViewProps {
  sessions: Session[];
  agents: AgentState[];
  connected: boolean;
  onSelectAgent: (agent: AgentState) => void;
}

export const OrbitalView = memo(function OrbitalView({ sessions, agents, connected, onSelectAgent }: OrbitalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(600);

  useEffect(() => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      const s = Math.min(el.clientWidth - 40, el.clientHeight - 40, 600);
      setSize(Math.max(300, s));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const cx = size / 2;
  const cy = size / 2;
  const baseRadius = size * 0.18;
  const ringStep = size * 0.11;

  // Map agents by target for quick lookup
  const agentMap = useMemo(() => {
    const m = new Map<string, AgentState>();
    for (const a of agents) m.set(a.target, a);
    return m;
  }, [agents]);

  const totalAgents = agents.length;

  return (
    <div className="flex flex-col items-center min-h-0 overflow-y-auto pb-12">
      {/* Hero */}
      <div className="text-center pt-12 pb-6">
        <h1
          className="text-5xl font-extralight tracking-[12px] uppercase"
          style={{ background: "linear-gradient(135deg, #26c6da 0%, #7e57c2 50%, #ffa726 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}
        >
          maw
        </h1>
        <div className="mt-3 text-[13px] text-white/30 tracking-[3px] uppercase">
          multi-agent workflow orchestra
        </div>
        <div className="mt-4 flex justify-center gap-6 text-[13px] text-white/40">
          <span>
            <span
              className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
              style={{ background: connected ? "#4caf50" : "#ef5350", animation: connected ? "pulse-dot 2s ease-in-out infinite" : undefined }}
            />
            {connected ? "live" : "connecting"}
          </span>
          <span><strong className="text-white/80 font-semibold">{totalAgents}</strong> agents</span>
          <span><strong className="text-white/80 font-semibold">{sessions.length}</strong> sessions</span>
        </div>
      </div>

      {/* Orbital map */}
      <div className="flex justify-center px-5 pb-8">
        <div ref={containerRef} className="relative" style={{ width: size, height: size }}>
          {/* Center hub */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10">
            <div
              className="flex flex-col items-center justify-center rounded-full"
              style={{ width: 80, height: 80, background: "radial-gradient(circle, #1a1a2e, #0d0d14)", border: "2px solid #26c6da" }}
            >
              <span className="text-[16px] font-semibold text-cyan-400 tracking-[2px]">maw</span>
              <span className="text-[9px] text-white/30 tracking-[1px] mt-0.5">orchestra</span>
            </div>
            {/* Resonance pulses */}
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-400/25 pointer-events-none"
                style={{ width: 90, height: 90, animation: `orbital-res 4s ease-in-out ${i * 1.3}s infinite` }}
              />
            ))}
          </div>

          {/* Orbital rings + nodes */}
          {sessions.map((session, si) => {
            const style = roomStyle(session.name);
            const radius = baseRadius + si * ringStep;
            return (
              <div key={session.name}>
                {/* Ring */}
                <div
                  className="absolute rounded-full pointer-events-none"
                  style={{
                    width: radius * 2, height: radius * 2,
                    top: cy - radius, left: cx - radius,
                    border: `1px solid ${style.accent}12`,
                  }}
                />
                {/* Nodes */}
                {session.windows.map((win, wi) => {
                  const angle = (2 * Math.PI * wi) / session.windows.length - Math.PI / 2;
                  const x = cx + radius * Math.cos(angle) - 30;
                  const y = cy + radius * Math.sin(angle) - 30;
                  const target = `${session.name}:${win.index}`;
                  const agent = agentMap.get(target);
                  const accent = agentColor(win.name);
                  const isBusy = agent?.status === "busy";

                  return (
                    <div
                      key={target}
                      className="absolute w-[60px] h-[60px] flex flex-col items-center justify-center cursor-pointer z-[5] transition-transform hover:scale-110 group"
                      style={{ left: x, top: y }}
                      onClick={() => agent && onSelectAgent(agent)}
                    >
                      {/* Tooltip */}
                      <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-[#1a1a2e] text-white/80 px-2 py-0.5 rounded text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-20 pointer-events-none">
                        {win.name}
                      </div>
                      <div
                        className="w-[56px] h-[56px] rounded-full flex flex-col items-center justify-center"
                        style={{
                          border: `2px solid ${accent}`,
                          background: `radial-gradient(circle at 30% 30%, #1a1a2e, #0a0a0f)`,
                          boxShadow: isBusy ? `0 0 12px ${accent}60` : undefined,
                          animation: isBusy ? `orbital-glow 3s ease-in-out infinite` : undefined,
                        }}
                      >
                        <span className="text-[9px] font-semibold text-center leading-tight max-w-[48px] truncate" style={{ color: accent }}>
                          {win.name.replace(/-oracle$/, "").replace(/-/g, " ")}
                        </span>
                        <span className="text-[8px] text-white/30 mt-0.5">{session.name}:{win.index}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Section header */}
      <div className="text-center py-6">
        <span className="text-[11px] tracking-[2.5px] uppercase text-white/30">
          Agents — One Soul, Many Windows
        </span>
        <div className="w-[60px] h-px mx-auto mt-3" style={{ background: "linear-gradient(90deg, transparent, #333, transparent)" }} />
      </div>

      {/* Agent cards */}
      <div className="max-w-[1050px] w-full mx-auto px-6 pb-16">
        {sessions.map(session => {
          const style = roomStyle(session.name);
          return (
            <div key={session.name} className="mb-8">
              <div
                className="text-[12px] tracking-[2px] uppercase py-2 mb-3 border-b border-white/[0.06]"
                style={{ color: style.accent }}
              >
                {session.name}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                {session.windows.map(win => {
                  const target = `${session.name}:${win.index}`;
                  const agent = agentMap.get(target);
                  const accent = agentColor(win.name);

                  return (
                    <div
                      key={target}
                      className="rounded-lg p-4 cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-lg"
                      style={{
                        background: "#0d0d14",
                        border: "1px solid rgba(255,255,255,0.06)",
                        borderLeft: `3px solid ${accent}`,
                      }}
                      onClick={() => agent && onSelectAgent(agent)}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className="w-[7px] h-[7px] rounded-full flex-shrink-0"
                          style={{
                            background: agent?.status === "busy" ? "#4caf50" : "#333",
                            boxShadow: agent?.status === "busy" ? "0 0 6px rgba(76,175,80,0.5)" : undefined,
                          }}
                        />
                        <span className="text-[14px] font-semibold" style={{ color: accent }}>{win.name}</span>
                        <span className="text-[11px] text-white/30 ml-auto font-mono">{target}</span>
                      </div>
                      <div className="text-[11px] font-mono text-white/30 h-8 overflow-hidden truncate">
                        {agent?.preview || ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
