import { useState } from "react";
import { useViewportInset } from "../hooks/useViewportInset";

interface BottomNavProps {
  activeView: string;
  askCount?: number;
  hrefMode?: "standalone" | "hash";
}

const NAV = [
  { id: "chat", label: "Chat", href: "/chat.html", icon: "💬" },
  { id: "fleet", label: "Fleet", href: "/fleet.html", icon: "◉" },
  { id: "mission", label: "Mission", href: "/mission.html", icon: "◆" },
  { id: "config", label: "Config", href: "/config.html", icon: "⚙" },
  { id: "more", label: "More", href: "#more", icon: "⋯" },
];

const ROOT_NAV = [
  { id: "mission", label: "Mission", href: "#mission", icon: "◆" },
  { id: "dashboard", label: "Dash", href: "#dashboard", icon: "▦" },
  { id: "fleet", label: "Fleet", href: "#fleet", icon: "◉" },
  { id: "office", label: "Office", href: "#office", icon: "⌂" },
  { id: "more", label: "More", href: "#more", icon: "⋯" },
];

const STANDALONE_MORE = [
  { id: "inbox", label: "Inbox", href: "/inbox.html", icon: "✉" },
  { id: "federation", label: "Federation", href: "/federation.html", icon: "⛓" },
  { id: "workspace", label: "Workspace", href: "/workspace.html", icon: "▤" },
  { id: "overview", label: "Overview", href: "/overview.html", icon: "◎" },
  { id: "dashboard", label: "Dashboard", href: "/dashboard.html", icon: "▦" },
  { id: "terminal", label: "Terminal", href: "/terminal.html", icon: "⌁" },
  { id: "office", label: "Office", href: "/office.html", icon: "⌂" },
];

const ROOT_MORE = [
  { id: "inbox", label: "Inbox", href: "#inbox", icon: "✉" },
  { id: "chat", label: "Chat", href: "#chat", icon: "💬" },
  { id: "federation", label: "Federation", href: "#federation", icon: "⛓" },
  { id: "vs", label: "VS", href: "#vs", icon: "⚔" },
  { id: "worktrees", label: "Worktrees", href: "#worktrees", icon: "▤" },
  { id: "skills", label: "Skills", href: "#skills", icon: "📘" },
  { id: "yailai", label: "Yailai", href: "#yailai", icon: "🔍" },
  { id: "config", label: "Config", href: "#config", icon: "⚙" },
  { id: "orbital", label: "Orbital", href: "#orbital", icon: "◌" },
  { id: "overview", label: "Overview", href: "#overview", icon: "◎" },
  { id: "teams", label: "Teams", href: "#teams", icon: "◫" },
];

export function BottomNav({ activeView, askCount = 0, hrefMode = "standalone" }: BottomNavProps) {
  const viewportInset = useViewportInset();
  const [moreOpen, setMoreOpen] = useState(false);
  const items = hrefMode === "hash" ? ROOT_NAV : NAV;
  const moreItems = hrefMode === "hash" ? ROOT_MORE : STANDALONE_MORE;
  const moreActive = moreItems.some((item) => item.id === activeView);

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-40 sm:hidden" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" />
          <div
            data-testid="more-sheet"
            className="absolute left-0 right-0 max-h-[62dvh] overflow-y-auto rounded-t-3xl border-t border-white/[0.08] px-4 pb-4 pt-3"
            style={{
              bottom: `calc(${viewportInset}px + 70px)`,
              paddingBottom: "max(16px, env(safe-area-inset-bottom, 0px))",
              background: "rgba(8,8,18,0.98)",
              boxShadow: "0 -20px 60px rgba(0,0,0,0.55)",
              animation: "slideUp 0.18s ease-out",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-[12px] font-bold uppercase tracking-[3px] text-white/45">More</span>
              <button
                data-testid="more-close"
                type="button"
                onClick={() => setMoreOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-xl text-white/45 active:scale-95"
                aria-label="Close menu"
              >
                ×
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {moreItems.map((item) => {
                const active = activeView === item.id;
                return (
                  <a
                    key={item.id}
                    data-testid={`more-item-${item.id}`}
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    className="relative flex min-h-[64px] flex-col items-center justify-center rounded-2xl font-mono text-[11px]"
                    style={{
                      color: active ? "#22d3ee" : "rgba(255,255,255,0.58)",
                      background: active ? "rgba(34,211,238,0.13)" : "rgba(255,255,255,0.045)",
                      border: `1px solid ${active ? "rgba(34,211,238,0.22)" : "rgba(255,255,255,0.06)"}`,
                    }}
                  >
                    <span className="text-[18px] leading-none">{item.icon}</span>
                    <span className="mt-1 max-w-full truncate px-1 leading-none">{item.label}</span>
                    {item.id === "inbox" && askCount > 0 && (
                      <span className="absolute right-2 top-2 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                        {askCount}
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <nav
        data-testid="bottom-nav"
        data-inset={viewportInset}
        className="mobile-bottom-nav fixed left-0 right-0 z-40 sm:hidden"
        aria-label="Primary"
        style={{
          bottom: viewportInset,
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          paddingLeft: "max(8px, env(safe-area-inset-left, 0px))",
          paddingRight: "max(8px, env(safe-area-inset-right, 0px))",
          background: "rgba(2,2,8,0.96)",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          backdropFilter: "blur(16px)",
        }}
      >
        <div className="grid grid-cols-5 gap-1 py-1.5">
          {items.map((item) => {
            const isMore = item.id === "more";
            const active = isMore ? moreOpen || moreActive : activeView === item.id;
            if (isMore) {
              return (
                <button
                  key={item.id}
                  data-testid="nav-more"
                  type="button"
                  onClick={() => setMoreOpen((open) => !open)}
                  className="mobile-bottom-nav-link relative flex min-h-[52px] flex-col items-center justify-center rounded-xl text-[10px] font-mono"
                  style={{
                    color: active ? "#22d3ee" : "rgba(255,255,255,0.45)",
                    background: active ? "rgba(34,211,238,0.12)" : "transparent",
                  }}
                  aria-expanded={moreOpen}
                  aria-label="More navigation"
                >
                  <span className="text-[18px] leading-none">{item.icon}</span>
                  <span className="mt-1 leading-none">{item.label}</span>
                  {askCount > 0 && (
                    <span className="absolute right-2 top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                      {askCount}
                    </span>
                  )}
                </button>
              );
            }
            return (
              <a
                key={item.id}
                data-testid={`nav-${item.id}`}
                href={item.href}
                className="mobile-bottom-nav-link relative flex min-h-[52px] flex-col items-center justify-center rounded-xl text-[10px] font-mono"
                style={{
                  color: active ? "#22d3ee" : "rgba(255,255,255,0.45)",
                  background: active ? "rgba(34,211,238,0.12)" : "transparent",
                }}
              >
                <span className="text-[16px] leading-none">{item.icon}</span>
                <span className="mt-1 leading-none">{item.label}</span>
              </a>
            );
          })}
        </div>
      </nav>
    </>
  );
}
