import { memo } from "react";
import type { AgentState, AgentEvent } from "../lib/types";

interface BottomStatsProps {
  agents: AgentState[];
  eventLog?: AgentEvent[];
}

export const BottomStats = memo(function BottomStats({ agents }: BottomStatsProps) {
  const busyCount = agents.filter((a) => a.status === "busy").length;
  const readyCount = agents.filter((a) => a.status === "ready").length;
  const idleCount = agents.filter((a) => a.status === "idle").length;

  return (
    <div className="mx-3 mb-3 mt-1 flex flex-wrap items-center justify-center gap-3 rounded-xl border border-white/[0.04] bg-black/40 px-4 py-2 backdrop-blur sm:absolute sm:bottom-4 sm:left-1/2 sm:m-0 sm:-translate-x-1/2 sm:flex-nowrap sm:gap-6 sm:px-6">
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-yellow-400" />
        <strong className="text-yellow-400 text-xs">{busyCount}</strong>
        <span className="text-[10px] text-white/50">busy</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-emerald-400" />
        <strong className="text-emerald-400 text-xs">{readyCount}</strong>
        <span className="text-[10px] text-white/50">ready</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-white/30" />
        <strong className="text-white/50 text-xs">{idleCount}</strong>
        <span className="text-[10px] text-white/50">idle</span>
      </span>
      <div className="w-24 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${Math.min(100, (busyCount / Math.max(1, agents.length)) * 100)}%`,
            background: busyCount > 5 ? "#ef5350" : busyCount > 2 ? "#fdd835" : "#4caf50",
          }}
        />
      </div>
    </div>
  );
});
