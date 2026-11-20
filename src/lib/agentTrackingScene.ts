import type { TrackedAgent, TrackedState } from "./agentTrackingModel.ts";

export interface Camera {
  yaw: number;
  pitch: number;
  zoom: number;
}

export interface TrackingPalette {
  bg: string;
  ink: string;
  dim: string;
  working: string;
  blocked: string;
  done: string;
}

export interface TrackingFrameOptions {
  palette: TrackingPalette;
  sans: string;
  mono: string;
  still: boolean;
  words: Record<TrackedState, string>;
  age: (ms: number) => string;
  empty: string;
  /** px at the top the caller covers (a top bar): the framing keeps boxes and callouts below it */
  top?: number;
  /** false holds the framing where it is (tests that compare geometry across frames); default on */
  fit?: boolean;
}

export interface TrackingScene {
  setAgents(list: TrackedAgent[]): void;
  frame(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, t: number,
        frameNo: number, cam: Camera, o: TrackingFrameOptions): void;
  hitAt(x: number, y: number): string | null;
  setHover(key: string | null): void;
  stats(): { total: number; working: number; blocked: number };
}

interface Point { x: number; y: number }
interface Point3 extends Point { z: number }
interface Slot { s: number; j: number }
interface AgentView {
  id: number;
  born: number;
  gone: number | null;
  changed: number;
  frozen: number;
  flashed: number | null;
  slot: Slot | null;
}
interface TrackGeometry {
  a: TrackedAgent;
  v: AgentView;
  p: Point;
  z: number;
  bw: number;
  bh: number;
  presence: number;
}
type AgentTrack = TrackGeometry & { kind: "agent" };
type Track = AgentTrack | (TrackGeometry & { kind: "sat"; id: number });
interface Link { A: AgentTrack; B: Track; strong: boolean; sat?: boolean }
interface Hit extends Point { key: string; w: number; h: number }

function stateInk(state: TrackedState, palette: TrackingPalette): string {
  switch (state) {
    case "working":
    case "blocked":
    case "done":
      return palette[state];
    default:
      return palette.ink;
  }
}

export const FPS = 30;
const DEPTH = 2;
export const AUTO_ROTATE = -0.11;
const GRID_OPACITY = 0.15;
const BEND = 0.15;
const LINK_WEIGHT = 1;
export const VIEW = { yaw: -0.42, pitch: 0.24, zoom: 1 };

// ---------------------------------------------------------------- noise
function hash(...n: number[]) {
  let h = 2166136261;
  for (const v of n) {
    h ^= Math.floor(v * 1000003) | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return ((h >>> 0) % 100000) / 100000;
}
function noise(x: number, seed: number) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash(i, seed) * 2 - 1;
  const b = hash(i + 1, seed) * 2 - 1;
  return a + (b - a) * u;
}
// String -> stable integer seed
function seedOf(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000003;
}

// ---------------------------------------------------------------- the invisible body
const STRANDS = 13;
const JOINTS = 14;
const FOCI = [
  { x: 0.5, y: 0.6, r: 0.13 },
  { x: 0.8, y: 0.3, r: 0.06 },
  { x: 0.24, y: 0.4, r: 0.08 },
];
const focusOf = (s: number) => (s % 3 === 0 ? 0 : s % 5 === 1 ? 1 : s % 5 === 2 ? 2 : 0);

function strand(s: number, t: number, w: number, h: number) {
  const f = FOCI[focusOf(s)]!;
  const cx = w * (f.x + 0.05 * noise(t * 0.18 + s * 3.1, 11 + s));
  const cy = h * (f.y + 0.05 * noise(t * 0.15 + s * 1.7, 29 + s));
  const bx = cx + w * f.r * noise(t * 0.4 + s * 7.3, 5 + s);
  const by = cy + h * f.r * noise(t * 0.35 + s * 4.9, 17 + s);
  let a = -1.15 + 0.5 * noise(t * 0.5 + s * 2.3, 41 + s) + (hash(s, 9) - 0.5) * 1.2;
  const seg = Math.min(w, h) * (0.022 + 0.012 * hash(s, 13));
  const pts = [];
  let x = bx;
  let y = by;
  for (let j = 0; j < JOINTS; j++) {
    pts.push({ x, y });
    a += 0.16 * noise(t * 0.9 + j * 0.37 + s * 5.1, 71 + s);
    x += Math.cos(a) * seg;
    y += Math.sin(a) * seg;
  }
  return pts;
}
function strandZ(s: number, j: number, t: number, S: number) {
  return S * ((hash(s, 51) - 0.5) * 0.6 + (hash(s, 52) - 0.5) * 0.03 * j + 0.05 * noise(t * 0.25 + s * 2.1, 61 + s));
}
const fog = (z: number, dist: number) => Math.max(0.3, Math.min(1, 1.6 - 0.7 * (z / dist)));

// ---------------------------------------------------------------- drawing helpers
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, ang: number, size = 5) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - Math.cos(ang - 0.45) * size, y - Math.sin(ang - 0.45) * size);
  ctx.lineTo(x - Math.cos(ang + 0.45) * size, y - Math.sin(ang + 0.45) * size);
  ctx.closePath();
  ctx.fill();
}

const RAMP = " .:-=+*#%@";
const CELL = { w: 6, h: 9 };
// ASCII density ramp in the box's own frame. `tt` is the box's own clock (frozen when idle),
// `level` scales density (sparse for plain shells).
function asciiFill(ctx: CanvasRenderingContext2D, bw: number, bh: number, node: Point,
                   id: number, tt: number, alpha: number, level: number, ink: string, mono: string) {
  const cols = Math.floor((bw - 2) / CELL.w);
  const rows = Math.floor((bh - 2) / CELL.h);
  if (cols < 1 || rows < 1) return;
  const ox = (bw - cols * CELL.w) / 2 + CELL.w / 2;
  const oy = (bh - rows * CELL.h) / 2 + CELL.h / 2;
  ctx.font = `400 8px ${mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = ink;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = ox + c * CELL.w;
      const py = oy + r * CELL.h;
      const d = Math.hypot((px - node.x) / Math.max(bw, 24), (py - node.y) / Math.max(bh, 24));
      const n = noise(c * 0.6 + tt * 2.4 + id * 13, 500 + r * 3 + id * 31);
      const v = Math.max(0, Math.min(0.999, (0.75 - d * 1.1 + n * 0.45) * level));
      const glyph = RAMP[Math.floor(v * RAMP.length)]!;
      if (glyph === " ") continue;
      ctx.globalAlpha = (0.25 + 0.6 * v) * alpha;
      ctx.fillText(glyph, px, py);
    }
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "start";
}

// Text that resolves out of glyph noise: chars past `p` (0..1) are scrambled.
function scrambled(text: string, p: number, seed: number) {
  if (p >= 1) return text;
  const cut = Math.floor(text.length * Math.max(0, p));
  let out = text.slice(0, cut);
  for (let i = cut; i < text.length; i++) {
    out += text[i] === " " ? " " : RAMP[1 + Math.floor(hash(seed, i, Math.floor(p * 40)) * (RAMP.length - 1))];
  }
  return out;
}

interface Fit { zoom: number; px: number; py: number }
const NO_FIT: Fit = { zoom: 1, px: 0, py: 0 };

/** `fit` is the scene's own framing on top of the user's orbit: a zoom-out and a pan in px. */
function camera(w: number, h: number, cam: Camera, fit: Fit = NO_FIT) {
  const f = Math.max(w, h) * 1.1;
  const dist = f * cam.zoom * fit.zoom;
  const cx = w / 2 + fit.px;
  const cy0 = h / 2 + fit.py;
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const rotate = (p: Point3) => {
    const x1 = p.x * cy + p.z * sy;
    const z1 = -p.x * sy + p.z * cy;
    return { x: x1, y: p.y * cp - z1 * sp, z: p.y * sp + z1 * cp };
  };
  const project = (p: Point3) => {
    const c = rotate(p);
    const z = Math.max(c.z + dist, 1);
    const s = f / z;
    return { x: cx + c.x * s, y: cy0 + c.y * s, s, z };
  };
  return { project, rotate, dist, f, cx, cy: cy0 };
}

// The caller supplies seconds from the same clock for both now() and frame().
export function createTrackingScene({ now }: { now: () => number }): TrackingScene {
  const agents = new Map<string, TrackedAgent>();
  const views = new Map<string, AgentView>();
  let hits: Hit[] = [];
  let hover: string | null = null;
  // last finish marker per pane, kept past a pane's fade-out (a PC that drops and comes back)
  const finishes = new Map<string, string | null>();
  // The framing: eased each frame toward keeping every box and callout on screen.
  const fit: Fit = { zoom: 1, px: 0, py: 0 };

  function refit(extent: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number, top: number) {
    if (!Number.isFinite(extent.x0)) return;
    const area = { x0: 16, y0: top + 12, x1: w - 16, y1: h - 48 };
    const aw = Math.max(1, area.x1 - area.x0);
    const ah = Math.max(1, area.y1 - area.y0);
    const k = Math.min(aw / Math.max(1, extent.x1 - extent.x0), ah / Math.max(1, extent.y1 - extent.y0));
    // zoom out until it fits; drift back in once there is a fair margin
    const zoom = k < 1 ? fit.zoom / k : k > 1.3 ? fit.zoom / (k / 1.3) : fit.zoom;
    const along = (a0: number, a1: number, e0: number, e1: number) =>
      e1 - e0 > a1 - a0 ? (a0 + a1) / 2 - (e0 + e1) / 2 : e0 < a0 ? a0 - e0 : e1 > a1 ? a1 - e1 : 0;
    fit.zoom += (Math.max(1, Math.min(3, zoom)) - fit.zoom) * 0.08;
    fit.px += along(area.x0, area.x1, extent.x0, extent.x1) * 0.08;
    fit.py += along(area.y0, area.y1, extent.y0, extent.y1) * 0.08;
    fit.px = Math.max(-w / 2, Math.min(w / 2, fit.px));
    fit.py = Math.max(-h / 2, Math.min(h / 2, fit.py));
  }

  function setAgents(list: TrackedAgent[]) {
    const time = now();
    const keep = new Set(list.map((agent) => agent.key));
    for (const [key, view] of views) {
      if (!keep.has(key) && view.gone === null) view.gone = time;
    }
    for (const agent of list) {
      const previous = agents.get(agent.key);
      agents.set(agent.key, agent);
      let view = views.get(agent.key);
      if (!view) {
        view = {
          id: seedOf(agent.key), born: time, changed: time, frozen: time,
          gone: null, flashed: null, slot: null,
        };
        views.set(agent.key, view);
      }
      view.gone = null;
      if (previous && previous.state !== agent.state) {
        view.changed = time;
        if (previous.state === "working") view.frozen = time;
      }
      // A finish flashes once: a new marker, or a change into done, on a pane already in view.
      // A pane that (re)appears only records its marker, so a reconnect replays nothing.
      const seen = finishes.get(agent.key);
      if (previous
        ? (agent.finish !== null && agent.finish !== previous.finish) || (agent.state === "done" && previous.state !== "done")
        : agent.finish !== null && seen !== undefined && agent.finish !== seen) {
        view.flashed = time;
      }
      finishes.set(agent.key, agent.finish);
    }
    hits = hits.filter((hit) => keep.has(hit.key));
  }

  // Keep existing slots. New agents spread across strands, grouped by workspace cluster.
  function assignSlots() {
    const pending = [...agents.values()].filter((a) => !views.get(a.key)?.slot);
    if (!pending.length) return;
    const taken = new Set<number>();
    const load = new Array<number>(STRANDS).fill(0);
    for (const v of views.values()) {
      if (!v.slot) continue;
      taken.add(v.slot.s * JOINTS + v.slot.j);
      load[v.slot.s] = load[v.slot.s]! + 1;
    }
    const sizes = new Map<string, number>();
    for (const a of agents.values()) sizes.set(a.cluster, (sizes.get(a.cluster) ?? 0) + 1);
    const order = [...sizes.keys()].sort((x, y) => sizes.get(y)! - sizes.get(x)! || x.localeCompare(y));
    const all = Array.from({ length: STRANDS }, (_, index) => index);
    pending.sort((a, b) => a.key.localeCompare(b.key));
    for (const a of pending) {
      const v = views.get(a.key)!;
      const focus = order.indexOf(a.cluster) % 3;
      const pool = order.length < 2 ? all : all.filter((s) => focusOf(s) === focus);
      const ranked = [...pool].sort((x, y) => load[x]! - load[y]! || hash(v.id, x, 1) - hash(v.id, y, 1));
      let placed: Slot | null = null;
      for (const s of [...ranked, ...all]) {
        const j0 = Math.floor(hash(v.id, s, 2) * (JOINTS - 6));
        for (let k = 0; k < JOINTS - 6 && !placed; k++) {
          const j = 3 + ((j0 + k * 5) % (JOINTS - 6));
          if (!taken.has(s * JOINTS + j)) placed = { s, j };
        }
        if (placed) break;
      }
      v.slot = placed ?? { s: v.id % STRANDS, j: 3 + (v.id % (JOINTS - 6)) };
      taken.add(v.slot.s * JOINTS + v.slot.j);
      load[v.slot.s] = load[v.slot.s]! + 1;
    }
  }

  // ---------------------------------------------------------------- frame
  // `t` is the scene clock (same base as `now`); `tb` drives the body and the churn, and stands
  // still under reduced motion while fades and reveals still run on `t`.
  const draw: TrackingScene["frame"] = (ctx, w, h, dpr, t, frameNo, cam, o) => {
    const tb = o.still ? 2.4 : t;
    const frame = o.still ? 0 : frameNo;
    const { palette } = o;
    const font = `500 11px ${o.sans}`;
    // State stamps are epoch milliseconds; the animation clock may be performance-relative.
    const epochMs = t * 1000 + (t < 1e9 ? performance.timeOrigin : 0);
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, w, h);
    const S = Math.min(w, h);
    const { project, rotate, dist, f, cx, cy } = camera(w, h, cam, fit);
    const extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const grow = (x: number, y: number, ew: number, eh: number) => {
      extent.x0 = Math.min(extent.x0, x); extent.y0 = Math.min(extent.y0, y);
      extent.x1 = Math.max(extent.x1, x + ew); extent.y1 = Math.max(extent.y1, y + eh);
    };
    const world = (p: Point, z: number) => ({ x: p.x - w / 2, y: p.y - h / 2, z });

    // Floor grid
    {
      const fy = h * 0.3;
      const R = Math.max(w, h) * 1.6;
      const step = Math.max(40, Math.round(S / 12));
      const K = Math.floor(R / step);
      const N = 16;
      const near = 24;
      const seg = (a: Point3, b: Point3) => {
        const ca = rotate(a);
        const cb = rotate(b);
        ca.z += dist;
        cb.z += dist;
        if (ca.z < near && cb.z < near) return;
        const cut = (p: Point3, q: Point3) => {
          const k = (near - p.z) / (q.z - p.z);
          return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k, z: near };
        };
        const pa = ca.z < near ? cut(ca, cb) : ca;
        const pb = cb.z < near ? cut(cb, ca) : cb;
        ctx.moveTo(cx + (pa.x * f) / pa.z, cy + (pa.y * f) / pa.z);
        ctx.lineTo(cx + (pb.x * f) / pb.z, cy + (pb.y * f) / pb.z);
      };
      ctx.lineWidth = 1;
      for (let k = -K; k <= K; k++) {
        const u = k * step;
        for (let i = 0; i < N; i++) {
          const v0 = -R + (2 * R * i) / N;
          const v1 = v0 + (2 * R) / N;
          const r = Math.hypot(u, (v0 + v1) / 2) / R;
          if (r >= 1) continue;
          ctx.strokeStyle = palette.ink;
          ctx.globalAlpha = GRID_OPACITY * (1 - r) ** 1.6;
          ctx.beginPath();
          seg({ x: u, y: fy, z: v0 }, { x: u, y: fy, z: v1 });
          seg({ x: v0, y: fy, z: u }, { x: v1, y: fy, z: u });
          ctx.stroke();
        }
      }
    }

    const live = Array.from({ length: STRANDS }, (_, s) => strand(s, tb, w, h));

    // Specks: the body's dust. Busier when more agents work.
    const working = [...agents.values()].filter((a) => a.state === "working").length;
    const specks = 14 + Math.min(24, working * 4);
    ctx.fillStyle = palette.ink;
    for (let i = 0; i < specks; i++) {
      const s = i % STRANDS;
      const j = Math.floor(hash(i, 21) * JOINTS);
      const q = live[s]![j]!;
      const dx = (hash(i, Math.floor(tb * 2), 23) - 0.5) * 60;
      const dy = (hash(i, Math.floor(tb * 2), 24) - 0.5) * 60;
      const dz = (hash(i, Math.floor(tb * 2), 25) - 0.5) * 60;
      const sp = project(world({ x: q.x + dx, y: q.y + dy }, (strandZ(s, j, tb, S) + dz) * DEPTH));
      ctx.globalAlpha = 0.55 * fog(sp.z, dist);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, (1 + 2.2 * hash(i, 22)) * sp.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Tracks: one per terminal (fading out when removed), plus satellites of working agents.
    const tracks: Track[] = [];
    for (const [key, v] of views) {
      if (!v.slot) continue;
      const a = agents.get(key);
      if (!a) continue;
      const fadeIn = Math.max(0, Math.min(1, (t - v.born) / 0.7));
      const fadeOut = v.gone !== null ? Math.min(1, 1 - (t - v.gone) / 0.6) : 1;
      if (fadeOut <= 0) {
        views.delete(key);
        agents.delete(key);
        continue;
      }
      const { s, j } = v.slot;
      const p = live[s]![j]!;
      const z = strandZ(s, j, tb, S) * DEPTH;
      const isWorking = a.state === "working";
      const tall = hash(v.id, 7) < 0.3;
      const jitter = isWorking ? 1 : 0;
      const bw = (tall ? 44 : 64) + 40 * hash(v.id, 8) ** 2 + 3 * jitter * hash(v.id, frame, 9);
      const bh = (tall ? 96 : 30) + (tall ? 60 : 30) * hash(v.id, 10) ** 2 + 3 * jitter * hash(v.id, frame, 11);
      tracks.push({ kind: "agent", a, v, p, z, bw, bh, presence: fadeIn * fadeOut });

      if (isWorking) {
        // Satellites: short-lived detections on nearby joints, the churn of a busy agent.
        for (let i = 0; i < 3; i++) {
          const life = 0.5 + 1.2 * hash(v.id, i, 1);
          const k = Math.floor((tb + hash(v.id, i, 2) * life) / life);
          if (hash(v.id, i, k, 3) < 0.35) continue;
          if (hash(v.id, i, frame, 4) < 0.06) continue;
          const dj = 1 + Math.floor(hash(v.id, i, k, 5) * 3);
          const jj = Math.max(0, Math.min(JOINTS - 1, j + (hash(v.id, i, k, 6) < 0.5 ? -dj : dj)));
          const ss = s;
          tracks.push({
            kind: "sat",
            a,
            v,
            id: v.id * 7 + i,
            p: live[ss]![jj]!,
            z: strandZ(ss, jj, tb, S) * DEPTH,
            bw: 12 + 30 * hash(v.id, i, k, 9) ** 2,
            bh: 12 + 36 * hash(v.id, i, k, 10) ** 2,
            presence: fadeIn * fadeOut,
          });
        }
      }
    }

    const byKey = new Map(tracks.filter((k): k is AgentTrack => k.kind === "agent").map((k) => [k.a.key, k]));

    // Links: parent -> child (with arrowheads), and a faint ring through each workspace's roots.
    const links: Link[] = [];
    for (const k of byKey.values()) {
      const parent = k.a.parent && byKey.get(k.a.parent);
      if (parent) links.push({ A: parent, B: k, strong: true });
    }
    const roots = new Map<string, AgentTrack[]>();
    for (const k of byKey.values()) {
      if (k.a.parent && byKey.has(k.a.parent)) continue;
      const key = k.a.cluster;
      const group = roots.get(key);
      if (group) group.push(k);
      else roots.set(key, [k]);
    }
    for (const group of roots.values()) {
      if (group.length < 2) continue;
      group.sort((x, y) => x.a.key.localeCompare(y.a.key));
      for (let i = 0; i < group.length - (group.length === 2 ? 1 : 0); i++) {
        links.push({ A: group[i]!, B: group[(i + 1) % group.length]!, strong: false });
      }
    }
    // Satellites hang off their agent with a hairline.
    for (const k of tracks) {
      if (k.kind === "sat") links.push({ A: byKey.get(k.a.key)!, B: k, strong: false, sat: true });
    }

    for (const { A, B, strong, sat } of links) {
      const a = world(A.p, A.z);
      const b = world(B.p, B.z);
      const c = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const len = Math.hypot(c.x, c.y, c.z) || 1;
      const flat = Math.hypot(c.x, c.y) || 1;
      const n1 = { x: -c.y / flat, y: c.x / flat, z: 0 };
      const n2 = { x: (c.y * n1.z - c.z * n1.y) / len, y: (c.z * n1.x - c.x * n1.z) / len, z: (c.x * n1.y - c.y * n1.x) / len };
      const ida = A.v.id;
      const idb = B.kind === "sat" ? B.id : B.v.id;
      const bend = sat ? 0.5 : strong ? BEND * 2.5 : BEND * 4;
      const side = 0.5 + (hash(ida, idb, 32) - 1);
      const bulge = side * 2.4 * bend * Math.max(len, 160) * (sat ? 0.25 : 1);
      const phi = (hash(ida, idb, 34) - 0.5) * 1.6;
      const k1 = Math.cos(phi) * bulge;
      const k2 = Math.sin(phi) * bulge;
      const m = { x: (a.x + b.x) / 2 + n1.x * k1 + n2.x * k2, y: (a.y + b.y) / 2 + n1.y * k1 + n2.y * k2, z: (a.z + b.z) / 2 + n2.z * k2 };
      const at = (u: number) => {
        const v = 1 - u;
        return project({
          x: v * v * a.x + 2 * v * u * m.x + u * u * b.x,
          y: v * v * a.y + 2 * v * u * m.y + u * u * b.y,
          z: v * v * a.z + 2 * v * u * m.z + u * u * b.z,
        });
      };
      const mid = at(0.5);
      const lit = hover === A.a.key || hover === B.a.key;
      const base = sat ? 0.22 : strong ? 0.5 : 0.16;
      const opacity = Math.min(1, (lit ? base * 2 : base) * fog(mid.z, dist) * Math.min(A.presence, B.presence));
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = palette.ink;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = sat ? 0.75 : LINK_WEIGHT;
      ctx.setLineDash(strong || sat ? [] : [2, 4]);
      ctx.beginPath();
      for (let i = 0; i <= 28; i++) {
        const q = at(i / 28);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (strong) {
        const tip = at(0.97);
        const prev = at(0.93);
        arrow(ctx, tip.x, tip.y, Math.atan2(tip.y - prev.y, tip.x - prev.x), 4 + LINK_WEIGHT);
        // A packet travels down a link while the child works.
        if (B.a.state === "working") {
          const u = (tb * 0.45 + hash(ida, idb, 35)) % 1;
          const q = at(u);
          ctx.globalAlpha = 0.9 * Math.min(A.presence, B.presence);
          ctx.fillStyle = palette.ink;
          ctx.beginPath();
          ctx.arc(q.x, q.y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Boxes, far to near.
    const boxes = tracks.map((k) => ({ k, node: project(world(k.p, k.z)) })).sort((A, B) => B.node.z - A.node.z);
    const placed: { x: number; y: number; w: number }[] = [];
    const nextHits: Hit[] = [];
    for (const { k, node } of boxes) {
      const { a, v } = k;
      const isSat = k.kind === "sat";
      const id = isSat ? k.id : v.id;
      const alarm = a.state === "blocked";
      const state = a.state;
      const lit = hover === a.key && !isSat;
      const alpha = fog(node.z, dist) * k.presence;
      // Appearance: boxes open from their node.
      const open = isSat ? 1 : Math.max(0, Math.min(1, (t - v.born) / 0.45)) ** 0.5;
      const bw = Math.max(6, Math.round(k.bw * open));
      const bh = Math.max(6, Math.round(k.bh * open));
      const bx = Math.round(node.x - bw * (0.2 + 0.6 * hash(id, 41))) + 0.5;
      const by = Math.round(node.y - bh * (0.1 + 0.5 * hash(id, 42))) + 0.5;

      // ASCII: churns while working, frozen when idle, sparse for plain shells.
      const level = state === "working" ? 1 : state === "none" ? 0.45 : alarm ? 0.9 : 0.75;
      const tt = o.still ? tb : state === "working" || alarm ? t : state === "none" ? t * 0.08 : v.frozen;
      const inkA = isSat ? 0.7 : state === "idle" || state === "done" ? 0.55 : state === "none" ? 0.45 : 1;
      ctx.setTransform(dpr, 0, 0, dpr, dpr * bx, dpr * by);
      asciiFill(ctx, bw, bh, { x: node.x - bx, y: node.y - by }, id, tt, alpha * inkA, level,
        alarm ? palette.blocked : palette.ink, o.mono);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Done: a flash that decays.
      const flashAge = v.flashed === null ? Infinity : Math.max(0, t - v.flashed);
      if (!isSat && flashAge < 1.6) {
        ctx.globalAlpha = 0.35 * (1 - flashAge / 1.6) * alpha;
        ctx.fillStyle = palette.done;
        ctx.fillRect(bx, by, bw, bh);
      }

      const stroke = alarm ? palette.blocked : palette.ink;
      const strokeA = isSat ? 0.6 : state === "working" || alarm || lit ? 1 : state === "none" ? 0.4 : 0.6;
      // Blocked/error boxes pulse.
      const pulse = alarm && !o.still ? 0.65 + 0.35 * Math.sin(tb * 6) : 1;
      ctx.globalAlpha = alpha * strokeA * pulse;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lit ? 1.5 : 1;
      ctx.strokeRect(bx, by, bw, bh);
      if (lit) {
        // Corner brackets outside the box: the "locked" reticle.
        const g = 5;
        const L = 7;
        ctx.beginPath();
        for (const [cx, cy, sx, sy] of [
          [bx - g, by - g, 1, 1],
          [bx + bw + g, by - g, -1, 1],
          [bx - g, by + bh + g, 1, -1],
          [bx + bw + g, by + bh + g, -1, -1],
        ] as const) {
          ctx.moveTo(cx + sx * L, cy);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx, cy + sy * L);
        }
        ctx.stroke();
      }
      ctx.fillStyle = stateInk(state, palette);
      ctx.beginPath();
      ctx.arc(node.x, node.y, isSat ? 2.5 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (!isSat) {
        ctx.fillStyle = palette.dim;
        arrow(ctx, node.x + 7, node.y - 3, -0.6, 4);
      }
      ctx.globalAlpha = 1;
      if (isSat) continue;

      if (v.gone === null && k.presence > 0) {
        nextHits.push({ key: a.key, x: bx - 4, y: by - 4, w: bw + 8, h: bh + 8 });
        grow(bx, by, bw, bh);
      }

      // Callout: two lines above the box, stepping up past labels already placed.
      const reveal = Math.max(0, Math.min(1, (t - v.born) / 0.6));
      const stateReveal = Math.max(0, Math.min(1, (t - v.changed) / 0.35));
      const head = scrambled(a.machine ? `${a.label} · ${a.machine}` : a.label, reveal, id);
      const word = o.words[state];
      const stateText = scrambled(word, stateReveal, id + 1);
      const duration = a.since === null || a.message !== null ? "" : o.age(Math.max(0, epochMs - a.since));
      const sub = a.message ?? `${a.workspace} · ${word}${duration ? ` ${duration}` : ""}`;
      ctx.font = font;
      ctx.textBaseline = "alphabetic";
      const headW = ctx.measureText(head + "  ").width;
      const stW = ctx.measureText(stateText).width;
      ctx.font = `400 9px ${o.mono}`;
      const subW = ctx.measureText(sub).width;
      const tw = Math.max(headW + stW, subW);
      const lx = Math.max(4, Math.min(w - tw - 4, bx));
      let ly = Math.max(26, by - 5);
      for (let guard = 0; guard < 8; guard++) {
        const hit = placed.find((p) => Math.abs(p.y - ly) < 27 && lx < p.x + p.w + 10 && p.x < lx + tw + 10);
        if (!hit) break;
        ly = hit.y - 27;
      }
      // Pushed off the top: hang the callout under the box instead.
      if (ly < 26) ly = Math.min(h - 6, by + bh + 26);
      placed.push({ x: lx, y: ly, w: tw });
      grow(lx, ly - 24, tw, 28);
      const la = Math.max(lit ? 1 : 0.55, alpha) * k.presence;
      ctx.globalAlpha = la;
      ctx.font = font;
      ctx.fillStyle = palette.ink;
      ctx.fillText(head, lx, ly - 12);
      ctx.fillStyle = stateInk(state, palette);
      ctx.fillText(stateText, lx + headW, ly - 12);
      ctx.font = `400 9px ${o.mono}`;
      ctx.fillStyle = palette.dim;
      ctx.fillText(sub, lx, ly);
      ctx.globalAlpha = 1;
    }
    hits = nextHits;
    if (o.fit !== false) refit(extent, w, h, o.top ?? 0);

    if (byKey.size === 0) {
      ctx.font = `400 10px ${o.mono}`;
      ctx.textAlign = "center";
      ctx.fillStyle = palette.dim;
      ctx.textBaseline = "middle";
      ctx.fillText(o.empty, w / 2, h / 2);
      ctx.textAlign = "start";
    }

    // Axis gizmo, bottom left
    {
      const gx = 34;
      const gy = h - 34;
      ctx.font = `400 9px ${o.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 1;
      for (const [label, vec] of [
        ["x", { x: 1, y: 0, z: 0 }],
        ["y", { x: 0, y: 1, z: 0 }],
        ["z", { x: 0, y: 0, z: 1 }],
      ] as const) {
        const r = rotate(vec);
        ctx.strokeStyle = palette.dim;
        ctx.fillStyle = palette.dim;
        ctx.beginPath();
        ctx.moveTo(gx, gy);
        ctx.lineTo(gx + r.x * 18, gy + r.y * 18);
        ctx.stroke();
        ctx.fillText(label, gx + r.x * 26, gy + r.y * 26);
      }
      ctx.textAlign = "start";
    }
  };

  function hitAt(x: number, y: number): string | null {
    // Boxes were painted far to near. The last matching rectangle is on top.
    for (let i = hits.length - 1; i >= 0; i--) {
      const box = hits[i]!;
      if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return box.key;
    }
    return null;
  }

  const frame: TrackingScene["frame"] = (ctx, w, h, dpr, t, frameNo, cam, o) => {
    if (![w, h, dpr, t, frameNo, cam.yaw, cam.pitch, cam.zoom].every(Number.isFinite) || w <= 0 || h <= 0 || dpr <= 0 || cam.zoom <= 0) {
      hits = [];
      return;
    }
    assignSlots();
    draw(ctx, w, h, dpr, t, frameNo, cam, o);
  };

  function stats() {
    const list = [...agents.values()].filter((a) => views.get(a.key)?.gone === null);
    return {
      total: list.length,
      working: list.filter((a) => a.state === "working").length,
      blocked: list.filter((a) => a.state === "blocked").length,
    };
  }

  return {
    setAgents,
    frame,
    hitAt,
    stats,
    setHover(key) { hover = key; },
  };
}
