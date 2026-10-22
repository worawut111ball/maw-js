import { create } from "zustand";

interface PreviewStore {
  /** target → preview text */
  previews: Record<string, string>;
  setPreview: (target: string, preview: string) => void;
  setPreviews: (updates: Record<string, string>) => void;
}

export const usePreviewStore = create<PreviewStore>()((set) => ({
  previews: {},
  setPreview: (target, preview) => set((s) => {
    if (s.previews[target] === preview) return s;
    return { previews: { ...s.previews, [target]: preview } };
  }),
  setPreviews: (updates) => set((s) => {
    let next = s.previews;
    let changed = false;
    for (const [target, preview] of Object.entries(updates)) {
      if (next[target] !== preview) {
        if (!changed) { next = { ...next }; changed = true; }
        next[target] = preview;
      }
    }
    return changed ? { previews: next } : s;
  }),
}));

/** Hook: subscribe to a single agent's preview (no re-render from other agents) */
export function useAgentPreview(target: string): string {
  return usePreviewStore((s) => s.previews[target] || "");
}
