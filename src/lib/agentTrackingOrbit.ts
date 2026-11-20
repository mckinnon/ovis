import type { TrackedAgent } from "./agentTrackingModel.ts";

/**
 * Agent tracking's layout: one agent at the centre (the hub) and the rest on rings round it.
 * The hub is the agent that started the most helpers (children, grandchildren, …); on a tie an
 * agent beats a plain terminal, then the lowest hc number (t3 before t12). Its helpers take the
 * inner ring, their helpers the next, and agents outside its tree the outermost. A full ring
 * spills outward.
 */

/** t12 -> 12; a pane id that is no hc address sorts after every one that is */
export function tNumber(paneId: string): number {
  const match = /^t(\d+)$/.exec(paneId);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/** how many shown agents sit below each one in the parent links */
export function helperCounts(agents: readonly TrackedAgent[]): Map<string, number> {
  const shown = new Set(agents.map((agent) => agent.key));
  const counts = new Map(agents.map((agent) => [agent.key, 0]));
  for (const agent of agents) {
    const seen = new Set([agent.key]);
    for (let up = agent.parent; up !== null && shown.has(up) && !seen.has(up); up = parentOf(agents, up)) {
      seen.add(up);
      counts.set(up, (counts.get(up) ?? 0) + 1);
    }
  }
  return counts;
}

function parentOf(agents: readonly TrackedAgent[], key: string): string | null {
  return agents.find((agent) => agent.key === key)?.parent ?? null;
}

export function hubOf(agents: readonly TrackedAgent[], counts = helperCounts(agents)): string | null {
  let best: TrackedAgent | null = null;
  for (const agent of agents) {
    if (best === null) { best = agent; continue; }
    const byHelpers = (counts.get(agent.key) ?? 0) - (counts.get(best.key) ?? 0);
    const byAgent = Number(agent.app !== null) - Number(best.app !== null);
    const byNumber = tNumber(best.paneId) - tNumber(agent.paneId);
    if (byHelpers > 0 || (byHelpers === 0 && (byAgent > 0 || (byAgent === 0 && (byNumber > 0 || (byNumber === 0 && agent.key < best.key)))))) best = agent;
  }
  return best?.key ?? null;
}

export interface OrbitPlace { ring: number; index: number; count: number }

const RING_ROOM = (ring: number): number => 8 + 4 * ring;

/** each agent but the hub: its ring (0 innermost) and its place among that ring's agents */
export function orbitPlaces(agents: readonly TrackedAgent[], hub: string | null): Map<string, OrbitPlace> {
  const shown = new Map(agents.map((agent) => [agent.key, agent]));
  const depth = (agent: TrackedAgent): number | null => {
    let d = 1;
    const seen = new Set([agent.key]);
    for (let up = agent.parent; up !== null && shown.has(up) && !seen.has(up); up = shown.get(up)!.parent, d++) {
      if (up === hub) return d;
      seen.add(up);
    }
    return null;
  };
  const wanted = agents.filter((agent) => agent.key !== hub).map((agent) => ({ agent, depth: depth(agent) }));
  const deepest = Math.max(0, ...wanted.map((item) => item.depth ?? 0));
  // siblings next to each other: by ring, then parent, then hc number
  wanted.sort((x, y) => (x.depth ?? deepest + 1) - (y.depth ?? deepest + 1)
    || (x.agent.parent ?? "").localeCompare(y.agent.parent ?? "")
    || tNumber(x.agent.paneId) - tNumber(y.agent.paneId) || x.agent.key.localeCompare(y.agent.key));
  const rings: TrackedAgent[][] = [];
  for (const { agent, depth: d } of wanted) {
    let ring = (d ?? deepest + 1) - 1;
    while ((rings[ring]?.length ?? 0) >= RING_ROOM(ring)) ring++;
    (rings[ring] ??= []).push(agent);
  }
  const places = new Map<string, OrbitPlace>();
  let drawn = 0;
  for (const members of rings) {
    if (!members) continue;
    members.forEach((agent, index) => places.set(agent.key, { ring: drawn, index, count: members.length }));
    drawn++;
  }
  return places;
}
