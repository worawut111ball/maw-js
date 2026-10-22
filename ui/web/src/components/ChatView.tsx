import { memo, useState } from "react";
import { agentColor } from "../lib/constants";
import { displayName } from "./chat/types";
import { ChatGroup, DateSeparator } from "./chat/ChatBubble";
import { ThreadCard } from "./chat/ThreadCard";
import { useChatLog, useOracleNames, useFilteredEntries, useTimelineGroups, useLiveGroups, useThreads } from "./chat/useChatLog";
import { QuickCommandBar } from "./QuickCommandBar";
import type { Session } from "../lib/types";

type Mode = "live" | "timeline" | "threads";

interface ChatViewProps {
  sessions?: Session[];
  send?: (msg: object) => void;
}

export const ChatView = memo(function ChatView({ sessions = [], send }: ChatViewProps) {
  const [filter, setFilter] = useState<string>("all");
  const [viewAs, setViewAs] = useState<string>("neo-oracle");
  const [mode, setMode] = useState<Mode>("timeline");
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const { entries, total, loading, sourceError, scrollRef } = useChatLog(mode);
  const oracleNames = useOracleNames(entries);
  const filtered = useFilteredEntries(entries, filter);
  const grouped = useTimelineGroups(filtered);
  const liveGrouped = useLiveGroups(filtered);
  const threads = useThreads(filtered);
  const quickTarget = sessions.flatMap((s) => s.windows.map((w) => ({ target: `${s.name}:${w.index}`, name: w.name }))).find(Boolean);

  const toggleHighlight = (id: string) => setHighlighted(highlighted === id ? null : id);

  return (
    <div className="flex flex-col h-[calc(100dvh-124px)] sm:h-[calc(100vh-48px)] min-w-0 pb-[56px] sm:pb-0" style={{ background: "#0a0a0f" }}>
      {/* Header */}
      <div
        className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 border-b flex-shrink-0 flex-wrap"
        style={{ borderColor: "rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.015)" }}
      >
        <h2 className="text-sm font-bold tracking-wider truncate max-w-full" style={{ color: "#64b5f6" }}>
          191 AI คุยกันเอง | Build with Oracle
        </h2>
        <span className="text-[10px] font-mono text-white/20">{filtered.length} msgs</span>
        {mode === "live" && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ animation: "agent-pulse 1.5s ease-in-out infinite" }} />
            <span className="text-[10px] font-mono text-emerald-400/60">LIVE</span>
          </span>
        )}

        <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-2 overflow-x-auto scrollbar-none">
          <div className="flex rounded-lg overflow-hidden flex-shrink-0" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
            {(["live", "timeline", "threads"] as const).map((m) => (
              <button
                key={m}
                className="min-h-8 px-2.5 py-1 text-[11px] font-mono capitalize transition-colors"
                style={{
                  background: mode === m ? "rgba(100,181,246,0.12)" : "transparent",
                  color: mode === m ? "#64b5f6" : "rgba(255,255,255,0.25)",
                }}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
          </div>

          <select
            value={viewAs}
            onChange={(e) => setViewAs(e.target.value)}
            className="min-h-8 max-w-[140px] sm:max-w-[180px] text-[11px] font-mono rounded-lg px-2 py-1 outline-none cursor-pointer flex-shrink-0"
            style={{ background: "rgba(255,255,255,0.05)", color: agentColor(viewAs), border: "1px solid rgba(255,255,255,0.08)" }}
          >
            {oracleNames.map((n) => (
              <option key={n} value={n}>{displayName(n)}</option>
            ))}
          </select>

          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="min-h-8 max-w-[140px] sm:max-w-[180px] text-[11px] font-mono rounded-lg px-2 py-1 outline-none cursor-pointer flex-shrink-0"
            style={{ background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.5)", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            <option value="all">All</option>
            {oracleNames.map((n) => (
              <option key={n} value={n}>{displayName(n)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Chat area */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 py-3 sm:py-4">
        {sourceError ? (
          <div
            role="alert"
            aria-live="polite"
            className="flex flex-col items-center justify-center h-full gap-2 px-4"
          >
            <p className="text-red-400/80 text-sm font-mono">chat source unavailable</p>
            <p className="text-white/40 text-xs font-mono max-w-md text-center">{sourceError}</p>
            <p className="text-white/25 text-[10px] font-mono">source: <code className="text-white/40">/api/feed</code> — see server logs or retry</p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-white/20 text-sm font-mono">Loading...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-white/25 text-sm">No messages yet</p>
          </div>
        ) : mode === "live" ? (
          <div className="max-w-2xl mx-auto flex flex-col gap-3 min-w-0">
            {liveGrouped.map(({ entries: g }, i) => (
              <ChatGroup key={`lv-${i}`} entries={g} isRight={false} highlighted={highlighted} onToggleHighlight={toggleHighlight} idPrefix={`lv-${i}`} />
            ))}
          </div>
        ) : mode === "threads" ? (
          <div className="max-w-2xl mx-auto flex flex-col gap-3 min-w-0">
            {threads.map(([pair, msgs], i) => (
              <ThreadCard key={pair} pair={pair} entries={msgs} viewAs={viewAs} defaultExpanded={i === 0} highlighted={highlighted} onToggleHighlight={toggleHighlight} />
            ))}
          </div>
        ) : (
          <div className="max-w-2xl mx-auto flex flex-col gap-4 min-w-0">
            {grouped.map(({ date, entries: g }, i) => (
              <div key={`tl-${i}`}>
                {date && <DateSeparator date={date} />}
                <ChatGroup entries={g} isRight={g[0].from === viewAs} highlighted={highlighted} onToggleHighlight={toggleHighlight} idPrefix={`tl-${i}`} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-center px-4 py-1.5 border-t flex-shrink-0" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
        <span className="text-[9px] font-mono text-white/10">AI คุยกันเอง | Build with Oracle</span>
      </div>
      <QuickCommandBar
        targetLabel={quickTarget?.name}
        disabled={!quickTarget || !send}
        onCommand={quickTarget && send ? (text) => send({ type: "send", target: quickTarget.target, text, force: true }) : undefined}
      />
    </div>
  );
});
