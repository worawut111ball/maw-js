import { useRef, useEffect, useCallback } from "react";
import { useFederationStore } from "./store";
import { drawGrid, drawClusterLabels, drawEdges, drawAgents, drawLegend } from "./draw";
import { isPhone, makeFrameGate } from "../../lib/motion";

export function Canvas2D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; camX: number; camY: number } | null>(null);

  // Subscribe to store via refs for the animation loop (avoids re-renders)
  const storeRef = useRef(useFederationStore.getState());
  useEffect(() => useFederationStore.subscribe(s => { storeRef.current = s; }), []);

  // Canvas draw loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let animId: number;
    let time = 0;
    // Phone: ≤20 fps · reduced motion: lower · hidden tab: skip
    const gate = makeFrameGate(20);

    function resize() {
      // Phone: cap backing store at 1.5x — full-screen gradients at 3x every frame heat the phone
      const dpr = Math.min(window.devicePixelRatio || 1, isPhone() ? 1.5 : 4);
      const rect = canvas!.getBoundingClientRect();
      canvas!.width = rect.width * dpr;
      canvas!.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);
    // Canvas box also changes without a window resize (phone: side panel stacks below)
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
    ro?.observe(canvas);

    function draw(now = performance.now()) {
      if (!gate(now)) { animId = requestAnimationFrame(draw); return; }
      time += 16;
      const W = canvas!.getBoundingClientRect().width;
      const H = canvas!.getBoundingClientRect().height;
      const { agents, edges, statuses, selected: sel, hovered: hov, flashes: fl, particles, edgePulses, showLineage, showHistoryEdges } = storeRef.current;
      const cam = camRef.current;

      // Background
      const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.7);
      bg.addColorStop(0, "#061525");
      bg.addColorStop(1, "#020a18");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.zoom, cam.zoom);

      drawGrid(ctx, cam, W, H, time);
      drawClusterLabels(ctx, agents);

      const byId = new Map(agents.map(a => [a.id, a]));
      drawEdges(ctx, edges, byId, sel, hov, particles, time, edgePulses, showLineage, showHistoryEdges);
      drawAgents(ctx, agents, edges, statuses, sel, hov, fl, time);

      ctx.restore();
      drawLegend(ctx, agents, H);

      animId = requestAnimationFrame(draw);
    }

    animId = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(animId); gate.dispose(); ro?.disconnect(); window.removeEventListener("resize", resize); };
  }, []);

  // Interaction helpers
  const screenToWorld = useCallback((sx: number, sy: number) => {
    const cam = camRef.current;
    return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom };
  }, []);

  const hitTest = useCallback((sx: number, sy: number): string | null => {
    const { x: wx, y: wy } = screenToWorld(sx, sy);
    for (const a of storeRef.current.agents) {
      const dx = wx - a.x, dy = wy - a.y;
      if (dx * dx + dy * dy < (15 / camRef.current.zoom) ** 2) return a.id;
    }
    return null;
  }, [screenToWorld]);

  const handleDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const hit = hitTest(sx, sy);
    if (hit) {
      dragRef.current = { id: hit, startX: sx, startY: sy, moved: false };
    } else {
      const cam = camRef.current;
      panRef.current = { startX: sx, startY: sy, camX: cam.x, camY: cam.y };
    }
  }, [hitTest]);

  const handleMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

    if (dragRef.current) {
      const d = dragRef.current;
      if (Math.abs(sx - d.startX) > 3 || Math.abs(sy - d.startY) > 3) d.moved = true;
      if (d.moved) {
        const { x: wx, y: wy } = screenToWorld(sx, sy);
        const agent = storeRef.current.agents.find(a => a.id === d.id);
        if (agent) { agent.x = wx; agent.y = wy; }
        canvasRef.current!.style.cursor = "grabbing";
        return;
      }
    }

    if (panRef.current) {
      const p = panRef.current;
      camRef.current.x = p.camX + (sx - p.startX);
      camRef.current.y = p.camY + (sy - p.startY);
      canvasRef.current!.style.cursor = "grabbing";
      return;
    }

    const hit = hitTest(sx, sy);
    useFederationStore.getState().setHovered(hit);
    canvasRef.current!.style.cursor = hit ? "grab" : "default";
  }, [hitTest, screenToWorld]);

  const handleUp = useCallback(() => {
    const d = dragRef.current;
    if (d && !d.moved) useFederationStore.getState().setSelected(d.id);
    dragRef.current = null;
    panRef.current = null;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const cam = camRef.current;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.max(0.3, Math.min(5, cam.zoom * factor));
    cam.x = sx - (sx - cam.x) * (newZoom / cam.zoom);
    cam.y = sy - (sy - cam.y) * (newZoom / cam.zoom);
    cam.zoom = newZoom;
  }, []);

  return (
    // Pointer events (not mouse) so one-finger drag pans and tap selects on phones
    <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ touchAction: "none" }}
      onPointerDown={handleDown} onPointerMove={handleMove}
      onPointerUp={handleUp} onPointerLeave={handleUp} onPointerCancel={handleUp}
      onWheel={handleWheel} />
  );
}
