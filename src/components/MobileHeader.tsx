const VIEW_LABELS: Record<string, string> = {
  mission: "Mission",
  dashboard: "Dash",
  fleet: "Fleet",
  office: "Office",
  inbox: "Inbox",
  chat: "Chat",
  federation: "Federation",
  vs: "VS",
  worktrees: "Worktree",
  config: "Config",
  terminal: "Terminal",
  skills: "Skills",
  yailai: "Yailai",
  overview: "Overview",
  teams: "Teams",
};

interface MobileHeaderProps {
  activeView: string;
  askCount: number;
  muted: boolean;
  onToggleMute: () => void;
  onInbox: () => void;
}

export function MobileHeader({ activeView, askCount, muted, onToggleMute, onInbox }: MobileHeaderProps) {
  const viewLabel = VIEW_LABELS[activeView] || activeView.replace(/-/g, " ");

  return (
    <div
      className="mobile-header fixed left-0 right-0 top-0 z-40 flex h-[calc(52px+env(safe-area-inset-top,0px))] items-center justify-between gap-2 border-b border-white/[0.08] bg-[#05050b]/82 px-4 backdrop-blur-xl sm:hidden"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="flex min-w-0 items-center gap-2 font-mono">
        <span className="text-[11px] leading-none">🟢</span>
        <span className="text-[13px] font-bold tracking-[2px] text-white/85">ARRA</span>
        <span className="text-white/25">·</span>
        <span className="truncate text-[12px] font-semibold text-cyan-300">{viewLabel}</span>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onInbox}
          className="relative flex h-10 min-w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.045] px-2 text-[15px] active:scale-95"
          aria-label="Inbox"
          title="Inbox"
        >
          🔔
          {askCount > 0 && (
            <span className="absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
              {askCount > 99 ? "99+" : askCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onToggleMute}
          className="flex h-10 min-w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.045] px-2 text-[15px] active:scale-95"
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
        >
          {muted ? "🔇" : "🔊"}
        </button>
      </div>
    </div>
  );
}
