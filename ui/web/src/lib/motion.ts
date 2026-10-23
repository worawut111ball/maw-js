/**
 * Phone-friendly animation budget (≤640px).
 * A budget Android phone overheated from endless per-frame work — so continuous
 * canvas / WebGL / rAF loops ask this module whether to draw a frame:
 *  - never while the page is hidden
 *  - phone: capped fps (default 20) · prefers-reduced-motion: lower still
 *  - desktop: unchanged (uncapped) unless reduced motion is requested
 */

export const PHONE_QUERY = "(max-width: 639.98px)";

export function isPhone(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(PHONE_QUERY).matches;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Max fps for a continuous loop. 0 = no cap. */
export function loopFpsCap(phoneFps = 20): number {
  const reduced = prefersReducedMotion();
  if (isPhone()) return reduced ? Math.min(10, phoneFps) : phoneFps;
  return reduced ? 30 : 0;
}

/**
 * Frame gate for rAF loops: call `gate(now)` at the top of the frame and skip the
 * work when it returns false. Re-reads the cap on resize so rotating / resizing works.
 */
export function makeFrameGate(phoneFps = 20) {
  let cap = loopFpsCap(phoneFps);
  let last = 0;
  const onResize = () => { cap = loopFpsCap(phoneFps); };
  if (typeof window !== "undefined") window.addEventListener("resize", onResize);
  const gate = (now: number): boolean => {
    if (typeof document !== "undefined" && document.hidden) return false;
    if (cap > 0 && now - last < 1000 / cap - 2) return false;
    last = now;
    return true;
  };
  gate.dispose = () => { if (typeof window !== "undefined") window.removeEventListener("resize", onResize); };
  return gate;
}
