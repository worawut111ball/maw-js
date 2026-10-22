import { memo, useState, useRef, useCallback, useEffect } from "react";
import { useFleetStore } from "../lib/store";
import { agentColor } from "../lib/constants";
import type { AskItem } from "../lib/types";

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const TYPE_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  input: { bg: "rgba(34,211,238,0.12)", text: "#22d3ee", label: "Input" },
  attention: { bg: "rgba(251,191,36,0.12)", text: "#fbbf24", label: "Attention" },
  plan: { bg: "rgba(168,85,247,0.12)", text: "#a855f7", label: "Approval" },
};

function AskCard({ ask, send, onClose }: { ask: AskItem; send: (msg: object) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dismissAsk = useFleetStore((s) => s.dismissAsk);
  const accent = agentColor(ask.oracle);
  const style = TYPE_STYLE[ask.type] || TYPE_STYLE.input;

  const sendReply = useCallback((reply: string) => {
    if (!ask.target) return;
    send({ type: "send", target: ask.target, text: reply });
    setTimeout(() => send({ type: "send", target: ask.target, text: "\r" }), 50);
    setSent(true);
    setTimeout(() => dismissAsk(ask.id), 600);
  }, [ask, send, dismissAsk]);

  const handleSend = useCallback(() => {
    if (!text.trim()) return;
    sendReply(text.trim());
    setText("");
  }, [text, sendReply]);

  if (sent) {
    return (
      <div className="rounded-xl p-4 border transition-all duration-300 opacity-50"
        style={{ background: "rgba(34,197,94,0.06)", borderColor: "rgba(34,197,94,0.2)" }}>
        <span className="text-sm text-emerald-400 font-mono">Sent</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-4 border transition-all"
      style={{ background: "rgba(255,255,255,0.03)", borderColor: `${accent}25` }}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{ background: `${accent}20`, color: accent }}>
          {ask.oracle.charAt(0).toUpperCase()}
        </div>
        <span className="text-[13px] font-semibold truncate" style={{ color: accent }}>
          {ask.oracle}
        </span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
          style={{ background: style.bg, color: style.text }}>
          {style.label}
        </span>
        <span className="text-[10px] font-mono text-white/25 ml-auto flex-shrink-0">{timeAgo(ask.ts)}</span>
      </div>

      {/* Message */}
      <p className="text-[13px] text-white/80 mb-3 leading-relaxed whitespace-pre-wrap line-clamp-3">
        {ask.message}
      </p>

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        {(ask.type === "plan" || ask.type === "attention") && (
          <button className="px-3 py-1.5 rounded-lg text-xs font-semibold active:scale-95 transition-all"
            style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}
            onClick={() => sendReply("y")}>
            Approve
          </button>
        )}
        {ask.type === "plan" && (
          <button className="px-3 py-1.5 rounded-lg text-xs font-semibold active:scale-95 transition-all"
            style={{ background: "rgba(239,68,68,0.12)", color: "#ef4444" }}
            onClick={() => sendReply("n")}>
            Reject
          </button>
        )}
        <input ref={inputRef} type="text" value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
          placeholder="Reply..."
          className="flex-1 min-w-0 px-3 py-1.5 rounded-lg text-xs text-white outline-none placeholder:text-white/20 [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.06)", WebkitAppearance: "none" as const }}
          enterKeyHint="send" autoComplete="off" autoCorrect="off"
        />
        {text.trim() && (
          <button className="px-2.5 py-1.5 rounded-lg text-xs active:scale-95 transition-all"
            style={{ background: `${accent}30`, color: accent }}
            onClick={handleSend}>
            Send
          </button>
        )}
        <button className="px-2 py-1.5 rounded-lg text-[10px] font-mono active:scale-95 transition-all"
          style={{ color: "rgba(255,255,255,0.3)" }}
          onClick={() => dismissAsk(ask.id)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export const InboxOverlay = memo(function InboxOverlay({ send, onClose }: { send: (msg: object) => void; onClose: () => void }) {
  const asks = useFleetStore((s) => s.asks);
  const pending = asks.filter((a) => !a.dismissed);
  const dismissed = asks.filter((a) => a.dismissed).slice(0, 5);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg mx-4 max-h-[70vh] flex flex-col rounded-2xl border overflow-hidden"
        style={{ background: "#0a0a12", borderColor: "rgba(255,255,255,0.08)", boxShadow: "0 25px 50px rgba(0,0,0,0.7)" }}
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <h2 className="text-sm font-bold tracking-wider text-cyan-400 uppercase">
            Inbox {pending.length > 0 && <span className="text-red-400">({pending.length})</span>}
          </h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60 text-lg leading-none px-1">&times;</button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {pending.length === 0 && (
            <div className="text-center py-10">
              <p className="text-white/30 text-sm">No pending asks</p>
              <p className="text-white/15 text-[11px] mt-1">Agents will appear here when they need input</p>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {pending.map((ask) => (
              <AskCard key={ask.id} ask={ask} send={send} onClose={onClose} />
            ))}
          </div>

          {dismissed.length > 0 && (
            <>
              <div className="text-[10px] font-mono text-white/15 uppercase tracking-wider mt-5 mb-2">Recent</div>
              <div className="flex flex-col gap-1">
                {dismissed.map((ask) => (
                  <div key={ask.id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg opacity-40"
                    style={{ background: "rgba(255,255,255,0.02)" }}>
                    <span className="text-xs font-semibold" style={{ color: agentColor(ask.oracle) }}>
                      {ask.oracle}
                    </span>
                    <span className="text-[10px] text-white/40 truncate flex-1">{ask.message}</span>
                    <span className="text-[9px] font-mono text-white/20 flex-shrink-0">{timeAgo(ask.ts)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
});
