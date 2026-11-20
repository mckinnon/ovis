import { expect, test } from "bun:test";
import type { TrackedAgent } from "./agentTrackingModel.ts";
import { createTrackingScene, VIEW, type TrackingFrameOptions } from "./agentTrackingScene.ts";

const palette = {
  bg: "black", ink: "white", dim: "gray", working: "green", blocked: "red", done: "gold",
};
const options: TrackingFrameOptions = {
  palette,
  sans: "system-ui",
  mono: "monospace",
  still: false,
  words: { working: "Working", idle: "Idle", done: "Done", blocked: "Blocked", none: "Shell" },
  age: (ms) => `${ms}ms`,
  empty: "No agents",
};

function agent(key: string, overrides: Partial<TrackedAgent> = {}): TrackedAgent {
  return {
    key, machineId: "local", paneId: key, label: key, app: "codex", state: "idle",
    message: null, workspace: "Work", cluster: "local/work", machine: null,
    parent: null, since: null, finish: null, ...overrides,
  };
}

function recordingContext() {
  const boxes: { x: number; y: number; w: number; h: number; alpha: number }[] = [];
  const texts: string[] = [];
  const flashes: number[] = [];
  const dust: number[][] = [];
  const finite = (...values: number[]) => {
    for (const value of values) {
      if (!Number.isFinite(value)) throw new Error(`Non-finite canvas input: ${value}`);
    }
  };
  const recorder = {
    globalAlpha: 1,
    fillStyle: "",
    strokeRect(x: number, y: number, w: number, h: number) {
      finite(x, y, w, h, this.globalAlpha);
      boxes.push({ x, y, w, h, alpha: this.globalAlpha });
    },
    fillRect(...values: number[]) {
      finite(...values, this.globalAlpha);
      if (this.fillStyle === palette.done) flashes.push(this.globalAlpha);
    },
    fillText(text: string, x: number, y: number) {
      finite(x, y, this.globalAlpha);
      texts.push(text);
    },
    measureText: (text: string) => ({ width: text.length * 6 }),
    beginPath() {},
    closePath() {},
    setLineDash() {},
    stroke() { finite(this.globalAlpha); },
    fill() { finite(this.globalAlpha); },
    arc(...values: number[]) {
      finite(...values);
      dust.push(values);
    },
    moveTo: finite,
    lineTo: finite,
    setTransform: finite,
  };
  return { ctx: recorder as unknown as CanvasRenderingContext2D, boxes, flashes, texts, dust };
}

function harness(still = false, initialTime = 0, fit = false) {
  let time = initialTime;
  const scene = createTrackingScene({ now: () => time });
  return {
    scene,
    at(t: number, frameNo = 0) {
      time = t;
      const recording = recordingContext();
      scene.frame(recording.ctx, 800, 600, 2, t, frameNo, VIEW, { ...options, still, fit, top: 48 });
      return recording;
    },
  };
}

test("new agents have finite geometry between frames and in still mode", () => {
  for (const still of [false, true]) {
    const { scene, at } = harness(still);
    at(0, 1);
    scene.setAgents([agent("working", { state: "working" })]);
    expect(at(0, 2).boxes.length).toBeGreaterThan(0);
    const settled = at(1, 30);
    expect(settled.texts).toContain("working");
    if (still) {
      const later = at(3, 90);
      expect(later.boxes).toEqual(settled.boxes);
      expect(later.dust).toEqual(settled.dust);
      expect(later.texts).toEqual(settled.texts);
    }
  }
});

test("removal at time zero fades and then deletes the box", () => {
  const { scene, at } = harness(true, -1);
  scene.setAgents([agent("removed")]);
  const box = at(0).boxes[0]!;
  expect(scene.hitAt(box.x, box.y)).toBe("removed");
  scene.setAgents([]);
  expect(scene.stats().total).toBe(0);
  expect(scene.hitAt(box.x, box.y)).toBeNull();
  const fading = at(0.3).boxes[0]!;
  expect(fading.alpha).toBeGreaterThan(0);
  expect(fading.alpha).toBeLessThan(box.alpha);
  expect(at(0.61).boxes).toEqual([]);
  expect(at(1).texts).toContain(options.empty);
});

test("existing slots stay fixed when the list or its clusters change", () => {
  const { scene, at } = harness(true);
  const first = agent("first");
  scene.setAgents([first]);
  const box = at(1).boxes[0]!;
  scene.setAgents([agent("new", { cluster: "other/work" }), { ...first, cluster: "other/work" }]);
  expect(at(2).boxes).toContainEqual(box);
});

test("hitAt picks the nearest box when rectangles overlap", () => {
  const { scene, at } = harness(true);
  const agents = Array.from({ length: 30 }, (_, i) => agent(`agent-${i}`));
  scene.setAgents(agents);
  const all = at(1).boxes;
  // Obtain each box's identity from a fresh scene with identical slots and the others faded out.
  const keyForBox = new Map<string, string>();
  for (const target of agents) {
    const single = harness(true);
    single.scene.setAgents(agents);
    single.at(1);
    single.scene.setAgents([target]);
    const box = single.at(2).boxes[0]!;
    keyForBox.set(JSON.stringify(box), target.key);
  }
  let overlap: { x: number; y: number; key: string } | undefined;
  for (const box of all) {
    const x = box.x + box.w / 2;
    const y = box.y + box.h / 2;
    const matches = all.filter((candidate) => x >= candidate.x && x <= candidate.x + candidate.w
      && y >= candidate.y && y <= candidate.y + candidate.h);
    if (matches.length < 2) continue;
    const key = keyForBox.get(JSON.stringify(matches[matches.length - 1]));
    if (key) {
      overlap = { x, y, key };
      break;
    }
  }
  expect(overlap).toBeDefined();
  expect(scene.hitAt(overlap!.x, overlap!.y)).toBe(overlap!.key);
});

test("a changed finish marker flashes once, even if the agent is idle", () => {
  const { scene, at } = harness(true);
  const idle = agent("finished");
  scene.setAgents([idle]);
  expect(at(1).flashes).toEqual([]);
  const firstFinish = { ...idle, finish: "1" };
  scene.setAgents([firstFinish]);
  expect(at(1.2).flashes).toHaveLength(1);
  at(2.5);
  scene.setAgents([{ ...firstFinish }]);
  expect(at(2.7).flashes).toEqual([]);
  scene.setAgents([{ ...idle, finish: "2" }]);
  expect(at(2.8).flashes).toHaveLength(1);
  expect(at(4.4).flashes).toEqual([]);
  scene.setAgents([{ ...idle, finish: "2", state: "done" }]);
  expect(at(4.5).flashes).toHaveLength(1);
});

test("callouts show translated state, duration and message", () => {
  const start = 1_795_000_000;
  const { scene, at } = harness(true, start);
  const tracked = agent("agent", {
    machine: "Remote", state: "blocked", since: start * 1000 - 500,
  });
  scene.setAgents([tracked]);
  expect(at(start + 1).texts).toEqual(expect.arrayContaining([
    "agent · Remote", "Blocked", "Work · Blocked 1500ms",
  ]));
  scene.setAgents([{ ...tracked, message: "Waiting for input" }]);
  expect(at(start + 2).texts).toContain("Waiting for input");
});

test("the framing brings every box below the top bar and inside the view", () => {
  const { scene, at } = harness(false, 0, true);
  scene.setAgents(Array.from({ length: 30 }, (_, i) => agent(`crowd-${i}`, { cluster: `local/w${i % 7}` })));
  let last = at(0, 0);
  for (let frame = 1; frame <= 240; frame++) last = at(frame / 30, frame);
  expect(last.boxes.length).toBe(30);
  for (const box of last.boxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(48);
    expect(box.x + box.w).toBeLessThanOrEqual(800);
    expect(box.y + box.h).toBeLessThanOrEqual(600);
  }
});

test("a pane that leaves and comes back with the same finish marker does not flash again", () => {
  const { scene, at } = harness();
  scene.setAgents([agent("remote", { finish: "1/a" })]);
  expect(at(0.5).flashes).toEqual([]);
  scene.setAgents([]);
  at(5);
  scene.setAgents([agent("remote", { finish: "1/a" })]);
  expect(at(5.2).flashes).toEqual([]);
  scene.setAgents([agent("remote", { finish: "2/b" })]);
  expect(at(5.4).flashes).toHaveLength(1);
});
