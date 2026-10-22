import { useMemo } from "react";
import { CORE_COMMANDS, type QuickCommand } from "../quickCommands";
import { useDevice } from "../hooks/useDevice";
import { useViewportInset } from "../hooks/useViewportInset";

const MOBILE_COMMANDS: QuickCommand[] = [
  ...CORE_COMMANDS,
  { label: "Tab", text: "\t", color: "#a78bfa" },
];

interface QuickCommandBarProps {
  onCommand?: (text: string, command: QuickCommand) => void;
  disabled?: boolean;
  targetLabel?: string | null;
  commands?: QuickCommand[];
}

export function QuickCommandBar({ onCommand, disabled, targetLabel, commands }: QuickCommandBarProps) {
  const { isMobile, isLandscape, width, height } = useDevice();
  const viewportInset = useViewportInset();
  const items = useMemo(() => commands ?? MOBILE_COMMANDS, [commands]);
  const phoneLandscape = isLandscape && width <= 932 && height < 640;

  if (!isMobile && !phoneLandscape) return null;

  const unavailable = disabled || !onCommand;

  return (
    <div
      data-testid="quick-command-bar"
      data-inset={viewportInset}
      className="mobile-quick-command-bar fixed left-0 right-0 z-50 sm:hidden"
      style={{
        bottom: viewportInset,
        transform: "translateY(-64px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        paddingLeft: "max(10px, env(safe-area-inset-left, 0px))",
        paddingRight: "max(10px, env(safe-area-inset-right, 0px))",
        background: "linear-gradient(180deg, rgba(2,2,8,0), rgba(2,2,8,0.96) 22%)",
      }}
    >
      <div
        className="flex items-center gap-2 overflow-x-auto scrollbar-none rounded-t-2xl px-2 py-2"
        style={{ borderTop: "1px solid rgba(255,255,255,0.08)", touchAction: "pan-x" }}
      >
        {targetLabel && (
          <span className="shrink-0 max-w-[90px] truncate rounded-lg px-2 py-1 text-[10px] font-mono text-white/35">
            {targetLabel}
          </span>
        )}
        {items.map((cmd) => (
          <button
            key={cmd.label}
            data-testid={`qc-${cmd.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`}
            type="button"
            disabled={unavailable}
            onClick={() => {
              if (unavailable) return;
              navigator.vibrate?.(8);
              onCommand?.(cmd.text, cmd);
            }}
            className="mobile-quick-command-button shrink-0 rounded-xl font-mono text-[12px] font-bold active:scale-95 disabled:opacity-35"
            style={{
              minWidth: Math.max(56, cmd.label.length * 9 + 24),
              minHeight: 44,
              padding: "0 13px",
              whiteSpace: "nowrap",
              background: `${cmd.color}16`,
              color: cmd.color,
              border: `1px solid ${cmd.color}35`,
            }}
          >
            {cmd.label}
          </button>
        ))}
      </div>
    </div>
  );
}
