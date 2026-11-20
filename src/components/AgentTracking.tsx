import { useEffect, useMemo, useRef, useState } from "react";
import { Radar, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { stateAge } from "./AgentSidebar.tsx";
import { trackedAgents, type TrackedState } from "../lib/agentTrackingModel.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";
import { useAgentStateStamps } from "../lib/useAgentStateSince.ts";
import type { Machine } from "../../shared/machines.ts";
import { AUTO_ROTATE, FPS, VIEW, createTrackingScene, type TrackingFrameOptions, type TrackingPalette } from "../lib/agentTrackingScene.ts";
import "./AgentTracking.css";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
// px the top bar covers: the scene frames its boxes below it
const TOP_BAR = 48;
// Bloom: two half-size copies of the frame, blurred and screened over it. Dark themes only:
// on a light ground a screen blend washes the scene out.
const BLOOM = [
  { blur: 11, opacity: 0.55 },
  { blur: 33, opacity: 0.385 },
] as const;

/** The theme's colours and faces, read from the tracking surface itself so every theme applies. */
function readLook(el: HTMLElement): { palette: TrackingPalette; sans: string; mono: string; dark: boolean } {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const bg = css.backgroundColor || v("--bg", "#000");
  return {
    palette: {
      bg,
      ink: v("--text-strong", "#fff"),
      dim: v("--text-dim", "#999"),
      working: v("--status-working", "#6cb8d6"),
      blocked: v("--status-blocked", "#ff7b70"),
      done: v("--status-done", "#93c36b"),
    },
    sans: v("--font-ui", "sans-serif"),
    mono: v("--font-mono", "monospace"),
    dark: luminance(bg) < 0.5,
  };
}

/** Relative luminance of an `rgb()`/`rgba()` colour; 0 when it can't be read (treated as dark). */
function luminance(color: string): number {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(color);
  if (!m) return 0;
  return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
}

/**
 * Agent tracking: every agent on every PC drawn as a live detection box in one 3D scene (the
 * "3D Tracking" overlay), with arcs from the agent that started a helper to the helper. A mode
 * of the app beside the agent inbox; clicking a box opens that agent's chat.
 */
export function AgentTracking({ machines, activity, onOpen, onClose }: {
  machines: readonly Machine[];
  activity: SidebarActivity;
  onOpen(machineId: string, paneId: string): void;
  /** a close button, where tracking is a screen of its own; none where it is a tab */
  onClose?: () => void;
}) {
  const t = useT();
  const stamps = useAgentStateStamps();
  const agents = useMemo(() => trackedAgents(machines, { status: activity.status, stamps }), [machines, activity, stamps]);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const bloomRefs = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];
  const [scene] = useState(() => createTrackingScene({ now: () => performance.now() / 1000 }));
  const [hot, setHot] = useState(false);
  const [dark, setDark] = useState(true);
  const byKey = useMemo(() => new Map(agents.map((agent) => [agent.key, agent])), [agents]);
  const byKeyRef = useRef(byKey);
  byKeyRef.current = byKey;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => scene.setAgents(agents), [scene, agents]);

  const words = useMemo<Record<TrackedState, string>>(() => ({
    working: t("Working"), idle: t("Idle"), done: t("Done"), blocked: t("Needs you"), none: t("Terminal"),
  }), [t]);
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const emptyRef = useRef("");
  emptyRef.current = t("No agents running");

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = sceneRef.current;
    const ctx = canvas?.getContext("2d");
    if (!stage || !canvas || !ctx) return;
    const blooms = bloomRefs.map((ref) => ref.current).filter((item): item is HTMLCanvasElement => item !== null);
    const size = { w: 0, h: 0, dpr: 1 };
    const orbit = { ...VIEW };
    const reduced = window.matchMedia(REDUCED_QUERY);
    let look = readLook(stage);
    setDark(look.dark);
    let lastFrame = -1;
    let raf = 0;
    const t0 = performance.now() / 1000;

    const resize = () => {
      const r = stage.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      Object.assign(size, { w: r.width, h: r.height, dpr });
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      for (const bloom of blooms) {
        bloom.width = Math.max(1, Math.round(r.width / 2));
        bloom.height = Math.max(1, Math.round(r.height / 2));
      }
      lastFrame = -1;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    // A theme change rewrites attributes on <html>: read the colours again.
    const themeWatch = new MutationObserver(() => {
      look = readLook(stage);
      setDark(look.dark);
      lastFrame = -1;
    });
    themeWatch.observe(document.documentElement, { attributes: true });

    const draw = () => {
      raf = 0;
      if (document.hidden) return;
      raf = window.requestAnimationFrame(draw);
      const { w, h, dpr } = size;
      if (!w || !h) return;
      const now = performance.now() / 1000;
      const frame = Math.floor(now * FPS);
      if (frame === lastFrame) return;
      lastFrame = frame;
      const still = reduced.matches;
      const options: TrackingFrameOptions = {
        palette: look.palette, sans: look.sans, mono: look.mono, still,
        words: wordsRef.current, age: stateAge, empty: emptyRef.current, top: TOP_BAR,
      };
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cam = { yaw: orbit.yaw + (still ? 0 : (now - t0) * AUTO_ROTATE), pitch: orbit.pitch, zoom: orbit.zoom };
      scene.frame(ctx, w, h, dpr, now, frame, cam, options);
      if (!look.dark) return;
      for (const bloom of blooms) {
        const bctx = bloom.getContext("2d");
        if (!bctx) continue;
        bctx.clearRect(0, 0, bloom.width, bloom.height);
        bctx.drawImage(canvas, 0, 0, bloom.width, bloom.height);
      }
    };
    const wake = () => { if (!document.hidden && raf === 0) raf = window.requestAnimationFrame(draw); };
    document.addEventListener("visibilitychange", wake);
    wake();

    // Drag orbits; a click without movement opens the box under it; a double-click on empty
    // space resets the view (on a box the first click has already opened it).
    let drag: { x: number; y: number; x0: number; y0: number; moved: boolean } | null = null;
    const local = (event: PointerEvent | MouseEvent) => {
      const r = stage.getBoundingClientRect();
      return { x: event.clientX - r.left, y: event.clientY - r.top };
    };
    const hover = (key: string | null) => {
      scene.setHover(key);
      setHot(key !== null);
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, x0: event.clientX, y0: event.clientY, moved: false };
      stage.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (drag) {
        if (Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) > 4) drag.moved = true;
        if (drag.moved) {
          stage.classList.add("is-dragging");
          orbit.yaw -= (event.clientX - drag.x) * 0.006;
          orbit.pitch = Math.max(-1.35, Math.min(1.35, orbit.pitch + (event.clientY - drag.y) * 0.006));
          lastFrame = -1;
        }
        drag.x = event.clientX;
        drag.y = event.clientY;
        return;
      }
      const p = local(event);
      hover(scene.hitAt(p.x, p.y));
    };
    const up = (event: PointerEvent) => {
      const started = drag;
      drag = null;
      stage.classList.remove("is-dragging");
      if (!started || started.moved || event.type !== "pointerup") return;
      const p = local(event);
      const key = scene.hitAt(p.x, p.y);
      // read through the current roster: a box still fading out after its pane left opens nothing
      const agent = key === null ? undefined : byKeyRef.current.get(key);
      if (agent) onOpenRef.current(agent.machineId, agent.paneId);
    };
    const leave = () => hover(null);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      orbit.zoom = Math.max(0.45, Math.min(2.5, orbit.zoom * Math.exp(event.deltaY * scale * 0.001)));
      lastFrame = -1;
    };
    const reset = (event: MouseEvent) => {
      const p = local(event);
      if (scene.hitAt(p.x, p.y) !== null) return;
      Object.assign(orbit, VIEW);
      lastFrame = -1;
    };
    stage.addEventListener("pointerdown", down);
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
    stage.addEventListener("pointerleave", leave);
    stage.addEventListener("wheel", wheel, { passive: false });
    stage.addEventListener("dblclick", reset);
    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      themeWatch.disconnect();
      document.removeEventListener("visibilitychange", wake);
      stage.removeEventListener("pointerdown", down);
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", up);
      stage.removeEventListener("pointercancel", up);
      stage.removeEventListener("pointerleave", leave);
      stage.removeEventListener("wheel", wheel);
      stage.removeEventListener("dblclick", reset);
    };
    // the scene and the canvases live as long as the view; words and agents arrive through refs
  }, [scene]);

  const counts = useMemo(() => ({
    total: agents.length,
    working: agents.filter((agent) => agent.state === "working").length,
    blocked: agents.filter((agent) => agent.state === "blocked").length,
  }), [agents]);

  return (
    <section className="agent-tracking" aria-label={t("Agent tracking")}>
      <header className="agent-tracking-top">
        <h2 className="agent-tracking-title">{t("Agent tracking")}</h2>
        <p className="agent-tracking-counts" role="status">
          {t("{total} running · {working} working · {blocked} need you", counts)}
        </p>
        {onClose && <button type="button" className="btn btn-ghost agent-tracking-close" onClick={onClose} aria-label={t("Back to Ovis")} title={t("Back to Ovis")}>
          <X aria-hidden="true" />
        </button>}
      </header>
      <div ref={stageRef} className={`agent-tracking-stage${hot ? " is-hot" : ""}`} aria-hidden="true">
        <canvas ref={sceneRef} className="agent-tracking-canvas" />
        {BLOOM.map((bloom, index) => (
          <canvas key={index} ref={bloomRefs[index]} className="agent-tracking-bloom" hidden={!dark}
            style={{ filter: `blur(${bloom.blur}px) brightness(1.6)`, opacity: bloom.opacity }} />
        ))}
      </div>
      {/* The scene as text, for assistive tech and keyboard users: the same agents, one button each. */}
      <ul className="visually-hidden">
        {agents.map((agent) => (
          <li key={agent.key}>
            <button type="button" onClick={() => onOpen(agent.machineId, agent.paneId)}>
              {[agent.label, words[agent.state], agent.workspace, agent.machine].filter(Boolean).join(", ")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The sidebar footer's way in, beside the agent inbox's. */
export function TrackingFootEntry({ onOpen }: { onOpen(): void }) {
  const t = useT();
  return (
    <button type="button" className="btn btn-ghost sidebar-footer-action sidebar-footer-pc inbox-foot-entry" onClick={onOpen}>
      <Radar aria-hidden="true" />
      <span className="sidebar-footer-pc-name">{t("Open agent tracking")}</span>
    </button>
  );
}
