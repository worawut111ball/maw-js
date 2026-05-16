import { agentColor } from "../../lib/constants";
import { ChibiAvatar } from "./ChibiAvatar";
import { type MawLogEntry, formatTime, displayName, isHuman } from "./types";

const FILE_URL_RE = /https?:\/\/[^\s)"']+\.(?:png|jpe?g|gif|webp|svg|pdf|txt|md|json|csv|log|zip|tar\.gz|mp4|mov|webm|mp3|wav)(?:\?[^\s)"']*)?|\/(?:api\/attach|uploads|files)\/[^\s)"']+/gi;
const CODE_BLOCK_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

function extensionForFence(fence: string): string {
  const lang = fence.trim().split(/\s+/)[0]?.toLowerCase() || "txt";
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    json: "json",
    py: "py",
    sh: "sh",
    bash: "sh",
    css: "css",
    html: "html",
    md: "md",
    markdown: "md",
    yaml: "yaml",
    yml: "yml",
    sql: "sql",
    rust: "rs",
    rs: "rs",
    go: "go",
  };
  return map[lang] || "txt";
}

function filenameFromUrl(url: string): string {
  try {
    const path = url.startsWith("http") ? new URL(url).pathname : url;
    return decodeURIComponent(path.split("/").filter(Boolean).pop() || "download");
  } catch {
    return "download";
  }
}

function downloadBlob(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function MessageDownloads({ msg }: { msg: string }) {
  const urls = [...msg.matchAll(FILE_URL_RE)].map((m) => m[0]);
  if (urls.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {urls.map((url, i) => (
        <a
          key={`${url}-${i}`}
          data-testid="msg-download"
          href={url}
          download={filenameFromUrl(url)}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center rounded-lg px-2.5 py-1 text-[11px] font-mono text-cyan-200 active:scale-95"
          style={{ minHeight: 36, background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.22)" }}
        >
          ⬇ Download
        </a>
      ))}
    </div>
  );
}

function MessageBody({ msg }: { msg: string }) {
  const parts: Array<{ type: "text" | "code"; text: string; fence?: string }> = [];
  let last = 0;
  for (const match of msg.matchAll(CODE_BLOCK_RE)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ type: "text", text: msg.slice(last, index) });
    parts.push({ type: "code", text: match[2] ?? "", fence: match[1] ?? "" });
    last = index + match[0].length;
  }
  if (last < msg.length) parts.push({ type: "text", text: msg.slice(last) });

  if (parts.length === 0) return <>{msg}</>;

  return (
    <>
      {parts.map((part, i) => {
        if (part.type === "text") return <span key={i}>{part.text}</span>;
        const ext = extensionForFence(part.fence || "");
        return (
          <div key={i} className="my-2 overflow-hidden rounded-xl" style={{ border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.2)" }}>
            <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <span className="text-[10px] font-mono text-white/35">{part.fence || "code"}</span>
              <button
                data-testid="msg-save-file"
                type="button"
                className="ml-auto rounded-lg px-2 py-1 text-[11px] font-mono text-emerald-200 active:scale-95"
                style={{ minHeight: 32, background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.22)" }}
                onClick={(e) => {
                  e.stopPropagation();
                  const name = window.prompt("Save as file", `snippet.${ext}`);
                  if (name) downloadBlob(part.text, name);
                }}
              >
                💾 Save as file
              </button>
            </div>
            <pre className="overflow-x-auto px-3 py-2 text-[12px] leading-relaxed"><code>{part.text}</code></pre>
          </div>
        );
      })}
    </>
  );
}

// ─── Single Bubble (used inside groups) ───

export function BubbleContent({ entry, isRight, highlighted, onToggle, isFirst, isLast }: {
  entry: MawLogEntry; isRight: boolean; highlighted: boolean; onToggle: () => void;
  isFirst: boolean; isLast: boolean;
}) {
  const human = isHuman(entry.from);
  const color = human ? "#e8b86d" : agentColor(entry.from);
  const radius = isRight
    ? `${isFirst ? "18px" : "6px"} 4px ${isLast ? "18px" : "6px"} 18px`
    : `4px ${isFirst ? "18px" : "6px"} 18px ${isLast ? "18px" : "6px"}`;

  return (
    <div
      className="px-4 py-2.5 whitespace-pre-wrap break-words cursor-pointer transition-all duration-200"
      style={{
        fontSize: "14.5px",
        lineHeight: "1.7",
        borderRadius: radius,
        color: highlighted ? "#fff" : isRight ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.8)",
        background: highlighted
          ? `${color}38`
          : human
            ? "rgba(232,184,109,0.12)"
            : isRight
              ? `${color}28`
              : "rgba(255,255,255,0.06)",
        border: `1px solid ${
          highlighted
            ? `${color}70`
            : human
              ? "rgba(232,184,109,0.25)"
              : isRight
                ? `${color}40`
                : "rgba(255,255,255,0.10)"
        }`,
        boxShadow: highlighted ? `0 0 20px ${color}25` : "none",
      }}
      onClick={onToggle}
    >
      <MessageBody msg={entry.msg} />
      <MessageDownloads msg={entry.msg} />
    </div>
  );
}

// ─── Grouped Chat Bubble (avatar + name once, stacked bubbles) ───

export function ChatGroup({ entries, isRight, highlighted, onToggleHighlight, idPrefix }: {
  entries: MawLogEntry[]; isRight: boolean;
  highlighted: string | null; onToggleHighlight: (id: string) => void;
  idPrefix: string;
}) {
  const sender = entries[0].from;
  const human = isHuman(sender);
  const color = human ? "#e8b86d" : agentColor(sender);
  const name = displayName(sender);

  return (
    <div
      className={`flex gap-2.5 max-w-[94%] sm:max-w-[82%] min-w-0 ${isRight ? "flex-row-reverse ml-auto" : ""}`}
    >
      <ChibiAvatar name={sender} size={36} />
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className={`flex items-baseline gap-2 mb-0.5 min-w-0 ${isRight ? "flex-row-reverse" : ""}`}>
          <span className="text-[13px] font-bold capitalize truncate" style={{ color }}>{name}</span>
          {human ? (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(232,184,109,0.15)", color: "#e8b86d" }}>Human</span>
          ) : (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(100,181,246,0.10)", color: "rgba(100,181,246,0.5)" }}>AI</span>
          )}
          <span className="text-[10px] text-white/15 font-mono">{formatTime(entries[0].ts)}</span>
          {entries.length > 1 && (
            <span className="text-[9px] text-white/10 font-mono">×{entries.length}</span>
          )}
        </div>
        {entries.map((entry, i) => {
          const id = `${idPrefix}-${i}`;
          return (
            <BubbleContent
              key={id}
              entry={entry}
              isRight={isRight}
              highlighted={highlighted === id}
              onToggle={() => onToggleHighlight(id)}
              isFirst={i === 0}
              isLast={i === entries.length - 1}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Single bubble with avatar (for ThreadCard) ───

export function ChatBubbleSingle({ entry, isRight, highlighted, onToggle }: {
  entry: MawLogEntry; isRight: boolean; highlighted: boolean; onToggle: () => void;
}) {
  const color = agentColor(entry.from);
  const name = displayName(entry.from);

  return (
    <div
      className={`flex gap-2.5 cursor-pointer transition-all duration-200 max-w-[94%] sm:max-w-[80%] min-w-0 ${isRight ? "flex-row-reverse ml-auto" : ""}`}
      onClick={onToggle}
    >
      <ChibiAvatar name={entry.from} size={36} />
      <div className="min-w-0 flex-1">
        <div className={`flex items-baseline gap-2 mb-1 min-w-0 ${isRight ? "flex-row-reverse" : ""}`}>
          <span className="text-[13px] font-bold capitalize truncate" style={{ color }}>{name}</span>
          <span className="text-[10px] text-white/15 font-mono">{formatTime(entry.ts)}</span>
        </div>
        <BubbleContent entry={entry} isRight={isRight} highlighted={highlighted} onToggle={onToggle} isFirst isLast />
      </div>
    </div>
  );
}

// ─── Date Separator ───

export function DateSeparator({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-3 my-5">
      <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
      <span className="text-[10px] font-mono text-white/20 tracking-wider">{date}</span>
      <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
    </div>
  );
}
