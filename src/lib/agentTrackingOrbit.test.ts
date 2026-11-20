import { describe, expect, it } from "bun:test";
import type { TrackedAgent } from "./agentTrackingModel.ts";
import { helperCounts, hubOf, orbitPlaces, tNumber } from "./agentTrackingOrbit.ts";

function agent(paneId: string, parent: string | null = null, app: string | null = "codex"): TrackedAgent {
  return {
    key: `local/${paneId}`, machineId: "local", paneId, label: paneId, app, state: "idle", message: null,
    workspace: "Work", cluster: "local/w", machine: null, parent: parent === null ? null : `local/${parent}`,
    since: null, finish: null, model: null,
  };
}

describe("agent tracking's orbit layout", () => {
  it("reads hc numbers, and sorts other pane ids last", () => {
    expect(tNumber("t12")).toBe(12);
    expect(tNumber("w1:p1")).toBe(Number.POSITIVE_INFINITY);
  });

  it("counts every helper below an agent, grandchildren too", () => {
    const counts = helperCounts([agent("t1"), agent("t5", "t1"), agent("t6", "t5"), agent("t9")]);
    expect(Object.fromEntries(counts)).toEqual({ "local/t1": 2, "local/t5": 1, "local/t6": 0, "local/t9": 0 });
  });

  it("puts the orchestrator at the centre, else the lowest hc number", () => {
    expect(hubOf([agent("t2"), agent("t9"), agent("t10", "t9")])).toBe("local/t9");
    expect(hubOf([agent("t12"), agent("t3"), agent("t7")])).toBe("local/t3");
    // a plain terminal loses a tie to an agent
    expect(hubOf([agent("t1", null, null), agent("t4")])).toBe("local/t4");
    expect(hubOf([])).toBeNull();
  });

  it("rings the hub's helpers inside, theirs next, and outsiders outermost", () => {
    const list = [agent("t1"), agent("t2", "t1"), agent("t3", "t1"), agent("t4", "t2"), agent("t8")];
    const places = orbitPlaces(list, "local/t1");
    expect(places.has("local/t1")).toBe(false);
    expect(places.get("local/t2")).toEqual({ ring: 0, index: 0, count: 2 });
    expect(places.get("local/t3")).toEqual({ ring: 0, index: 1, count: 2 });
    expect(places.get("local/t4")?.ring).toBe(1);
    expect(places.get("local/t8")?.ring).toBe(2);
  });

  it("spills a full ring outward, and leaves no empty ring between", () => {
    const list = [agent("t1"), ...Array.from({ length: 10 }, (_, i) => agent(`t${i + 2}`, "t1"))];
    const places = [...orbitPlaces(list, "local/t1").values()];
    expect(places.filter((place) => place.ring === 0)).toHaveLength(8);
    expect(places.filter((place) => place.ring === 1)).toHaveLength(2);
    // with no helpers at all, everyone shares the first ring
    expect([...orbitPlaces([agent("t1"), agent("t2"), agent("t3")], "local/t1").values()].map((place) => place.ring)).toEqual([0, 0]);
  });

  it("survives a parent loop without hanging", () => {
    const list = [agent("t1", "t2"), agent("t2", "t1")];
    expect(helperCounts(list).get("local/t1")).toBe(1);
    expect(orbitPlaces(list, "local/t1").get("local/t2")?.ring).toBe(0);
  });
});
