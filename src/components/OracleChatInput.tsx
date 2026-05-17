import { forwardRef, memo, useCallback, useEffect, useRef, useState } from "react";
import { useFileAttach, FileInput, AttachmentChips } from "../hooks/useFileAttach";
import type { AgentState } from "../lib/types";

interface OracleChatInputProps {
  agent: AgentState;
  send: (msg: object) => void;
  target: string;
  externalInputBuf?: string;
  onInputBufChange?: (val: string) => void;
  onClose?: () => void;
  onFullscreen?: () => void;
  onCommand?: (target: string, detail: string) => void;
}

const COMMANDS = [
  { label: "y", text: "y\r", color: "#22C55E" },
  { label: "n", text: "n\r", color: "#ef5350" },
  { label: "↵", text: "\r", color: "#64748B" },
  { label: "↑", text: "\x1b[A", color: "#64748B" },
  { label: "↓", text: "\x1b[B", color: "#64748B" },
  { label: "Tab", text: "\t", color: "#a78bfa" },
  { label: "/recap", text: "/recap\r", color: "#fbbf24" },
  { label: "/help", text: "/help\r", color: "#42a5f5" },
  { label: "Ctrl+C", text: "\x03", color: "#ef5350" },
  { label: "Ctrl+Z", text: "\x1a", color: "#ffa726" },
  { label: "exit", text: "exit\r", color: "#94A3B8" },
];

export const OracleChatInput = memo(forwardRef<HTMLInputElement, OracleChatInputProps>(function OracleChatInput({
  agent,
  send,
  target,
  externalInputBuf,
  onInputBufChange,
  onClose,
  onFullscreen,
  onCommand,
}, forwardedRef) {
  const [localInputBuf, setLocalInputBuf] = useState("");
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const localInputRef = useRef<HTMLInputElement>(null);
  const streamingRef = useRef(false);
  const prevInputRef = useRef("");
  const inputBuf = externalInputBuf ?? localInputBuf;
  const {
    uploading,
    attachments,
    inputRef: fileInputRef,
    mode: fileAttachMode,
    pickFile,
    pickCamera,
    pickGallery,
    onFileChange,
    removeAttachment,
    clearAttachments,
    buildMessage,
    onPaste,
  } = useFileAttach();

  const setInputRef = useCallback((node: HTMLInputElement | null) => {
    localInputRef.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  const setInputBuf = useCallback((val: string) => {
    setLocalInputBuf(val);
    onInputBufChange?.(val);
  }, [onInputBufChange]);

  useEffect(() => {
    if (externalInputBuf !== undefined) prevInputRef.current = externalInputBuf;
  }, []);

  const focusInput = useCallback(() => {
    localInputRef.current?.focus();
  }, []);

  const sendInput = useCallback((forceEnter = false) => {
    if (streamingRef.current) {
      onCommand?.(target, inputBuf);
      send({ type: "send", target, text: "\r" });
      streamingRef.current = false;
    } else if (inputBuf || attachments.length > 0) {
      const message = buildMessage(inputBuf);
      onCommand?.(target, message);
      send({ type: "send", target, text: message });
      clearAttachments();
    } else if (forceEnter) {
      send({ type: "send", target, text: "\r" });
    }
    setInputBuf("");
    prevInputRef.current = "";
    focusInput();
  }, [attachments.length, buildMessage, clearAttachments, focusInput, inputBuf, onCommand, send, setInputBuf, target]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose?.(); return; }
    if (e.key === "F11" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      onFullscreen?.();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      sendInput(false);
      return;
    }
    if (e.key === "Backspace" && streamingRef.current) {
      send({ type: "send", target, text: "\b" });
    }
  }, [onClose, onFullscreen, send, sendInput, target]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const prev = prevInputRef.current;
    prevInputRef.current = val;
    setInputBuf(val);

    if (val === "/" && prev === "") {
      streamingRef.current = true;
      send({ type: "send", target, text: "/" });
      return;
    }

    if (streamingRef.current && val.length > prev.length) {
      const newChars = val.slice(prev.length);
      for (const ch of newChars) send({ type: "send", target, text: ch });
    }

    if (streamingRef.current && !val.startsWith("/")) {
      streamingRef.current = false;
    }
  }, [send, setInputBuf, target]);

  return (
    <>
      <div
        className="relative flex flex-col gap-2 px-3 py-2 bg-[#0e0e18] border-t border-white/[0.06] font-mono text-xs cursor-text"
        onClick={focusInput}
      >
        <FileInput inputRef={fileInputRef} onChange={onFileChange} mode={fileAttachMode} />
        <AttachmentChips attachments={attachments} onRemove={removeAttachment} uploading={uploading} />
        {attachMenuOpen && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.08] bg-[#11111d]/95 p-2 shadow-2xl backdrop-blur"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {[
              { label: "📷 กล้อง", action: pickCamera },
              { label: "🖼 รูป", action: pickGallery },
              { label: "📁 ไฟล์", action: () => pickFile("file") },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  item.action();
                  setAttachMenuOpen(false);
                }}
                className="min-h-11 shrink-0 rounded-xl border border-white/[0.08] bg-white/[0.045] px-3 text-[12px] text-white/75 active:scale-95"
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setAttachMenuOpen((open) => !open);
            }}
            className="flex min-h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.045] text-base text-white/65 transition-colors active:scale-95 hover:bg-white/[0.08] hover:text-white"
            title="Attach file"
            aria-label="Attach file"
          >
            📎
          </button>
          <span className="text-cyan-400 font-semibold shrink-0">&#x276f;</span>
          <input
            ref={setInputRef}
            type="text"
            value={inputBuf}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={onPaste}
            className="min-w-0 flex-1 bg-transparent text-white/90 outline-none caret-cyan-400 font-mono text-xs [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
            style={{ caretColor: "#22d3ee", WebkitAppearance: "none" }}
            inputMode="text"
            enterKeyHint="send"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            placeholder="type command..."
          />
          {(inputBuf || attachments.length > 0) && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setInputBuf("");
                prevInputRef.current = "";
                clearAttachments();
                if (streamingRef.current) {
                  send({ type: "send", target, text: "\x15" });
                  streamingRef.current = false;
                }
                focusInput();
              }}
              className="shrink-0 w-6 h-6 rounded-full bg-white/[0.06] text-white/30 hover:text-white/60 hover:bg-white/10 cursor-pointer flex items-center justify-center text-[10px] transition-colors"
              title="Clear"
            >
              ✕
            </button>
          )}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              sendInput(true);
            }}
            className="shrink-0 px-3 py-2 sm:px-4 rounded-lg bg-cyan-500 text-black text-xs font-bold cursor-pointer hover:bg-cyan-400 active:bg-cyan-600 transition-colors shadow-lg shadow-cyan-500/20"
          >
            SEND
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto bg-[#0a0a14] px-3 py-2 border-t border-white/[0.04] scrollbar-none" style={{ touchAction: "pan-x" }}>
        {COMMANDS.map(cmd => (
          <button
            key={cmd.label}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              send({ type: "send", target, text: cmd.text });
              onCommand?.(target, cmd.label);
              focusInput();
            }}
            className="min-h-10 shrink-0 rounded-lg px-3 py-1 text-[10px] font-mono cursor-pointer active:scale-90 transition-all"
            style={{ background: `${cmd.color}15`, color: cmd.color, border: `1px solid ${cmd.color}25` }}
          >
            {cmd.label}
          </button>
        ))}
      </div>
    </>
  );
}));
