import { describe, expect, it } from "bun:test";
import { HC_OTHER_WORKSPACE_ID, type Machine, type MachineState } from "../../shared/machines.ts";
import type { AgentInfo, AgentStatus, HerdrPane, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import type { StateStamps } from "./agentStateSince.ts";
import { trackedAgents, type TrackingContext } from "./agentTrackingModel.ts";

function workspace(id: string, label = id): WorkspaceInfo {
  return { workspace_id: id, active_tab_id: `${id}:t1`, label, number: 1, tab_count: 1, pane_count: 1, focused: false, agent_status: "idle" };
}

function tab(id: string, workspaceId: string): TabInfo {
  return { tab_id: id, workspace_id: workspaceId, label: id, number: 1, pane_count: 1, focused: false, agent_status: "idle" };
}

function pane(id: string, overrides: Partial<HerdrPane> = {}): HerdrPane {
  return { pane_id: id, workspace_id: "w1", tab_id: "w1:t1", terminal_id: `${id}:term`, revision: 1, focused: false, agent_status: "idle", ...overrides };
}

function snapshot(panes: HerdrPane[], agents: AgentInfo[] = [], workspaces: WorkspaceInfo[] = [workspace("w1", "Project")], finishEpoch?: string): SessionSnapshot {
  return {
    protocol: 22, version: "test", workspaces: workspaces, layouts: [], panes, agents,
    tabs: workspaces.map((ws) => tab(ws.active_tab_id, ws.workspace_id)),
    focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null,
    ...(finishEpoch === undefined ? {} : { finish_epoch: finishEpoch }),
  };
}

function machine(id: string, state: MachineState, snap: SessionSnapshot | null, name = id): Machine {
  return { id, name, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null, snapshot: snap };
}

/** the status each pane carries, as SidebarActivity's default does before any seen record */
function ctx(stamps: StateStamps = {}, status?: (machineId: string, pane: HerdrPane) => AgentStatus | undefined): TrackingContext {
  return { status: status ?? ((_machineId, pane) => pane.agent_status), stamps };
}

describe("trackedAgents", () => {
  it("tracks every pane: agents in the sidebar's words, plain shells as none, sorted by key", () => {
    const working = pane("w1:p1", { agent: "codex", agent_status: "working", label: "Review" });
    const blocked = pane("a2", { agent: "claude", agent_status: "blocked", agent_message: "Allow npm install?" });
    const shell = pane("s1", { title: "bash" });
    const rows = trackedAgents([machine("local", "connected", snapshot([shell, blocked, working]))], ctx());
    expect(rows.map((row) => row.key)).toEqual(["local/a2", "local/s1", "local/w1:p1"]);
    expect(rows[0]).toMatchObject({ machineId: "local", paneId: "a2", app: "claude", state: "blocked", message: "Allow npm install?", workspace: "Project", cluster: "local/w1", machine: null, parent: null, since: null, finish: null });
    expect(rows[1]).toMatchObject({ app: null, state: "none", message: null, since: null });
    expect(rows[2]).toMatchObject({ label: "Review", app: "codex", state: "working" });
  });

  it("reads the seen-aware status from ctx.status, folding background waiting into working", () => {
    const waiting = pane("w", { agent: "claude", agent_status: "idle", background_wait: true });
    const seenDone = pane("d", { agent: "codex", agent_status: "done" });
    const status: TrackingContext["status"] = (_id, p) => p.pane_id === "w" ? "waiting" : p.pane_id === "d" ? "idle" : p.agent_status;
    const rows = trackedAgents([machine("local", "connected", snapshot([waiting, seenDone]))], ctx({}, status));
    expect(rows.map((row) => [row.paneId, row.state])).toEqual([["d", "idle"], ["w", "working"]]);
  });

  it("names a row's task: its label, then a title, never the workspace or the agent's own name", () => {
    const labelled = pane("l", { agent: "codex", label: "Docs", title: "Codex" });
    const titled = pane("t", { agent: "codex", title: "Fix the flaky test" });
    const named = pane("n", { agent: "codex", title: "Codex" });
    const plain = pane("p", {});
    const shell = pane("s", { title: "me@host: ~/project" });
    const suffixed = pane("x", { agent: "codex", title: "Fix the flaky test | Project" });
    const rows = trackedAgents([machine("local", "connected", snapshot([labelled, titled, named, plain, shell, suffixed]))], ctx());
    const label = (id: string) => rows.find((row) => row.paneId === id)?.label;
    expect(label("l")).toBe("Docs");
    expect(label("t")).toBe("Fix the flaky test");
    expect(label("n")).toBe(""); // the first line shows codex/model alone
    expect(label("p")).toBe("p");
    expect(label("s")).toBe("s"); // a plain shell's user@host title: its pane id
    expect(label("x")).toBe("Fix the flaky test");
  });

  it("takes the state's start from the stamps, matching pane, terminal and stamped state", () => {
    const stamps: StateStamps = {
      local: { lifetime: "h1", epoch: "e1", rows: {
        w: { state: "working", at: 1000, terminal: "w:term" },
        b: { state: "idle", at: 2000, terminal: "b:term" },
        x: { state: "working", at: 3000, terminal: "other:term" },
      } },
    };
    const working = pane("w", { agent: "claude", agent_status: "working" });
    const blocked = pane("b", { agent: "claude", agent_status: "blocked" });
    const moved = pane("x", { agent: "claude", agent_status: "working" });
    const rows = trackedAgents([machine("local", "connected", snapshot([working, blocked, moved]))], ctx(stamps));
    const since = (id: string) => rows.find((row) => row.paneId === id)?.since;
    expect(since("w")).toBe(1000);
    expect(since("b")).toBeNull(); // the stamp tells of another state
    expect(since("x")).toBeNull(); // the stamp names another terminal
  });

  it("looks a done row's stamp up as idle, as the sidebar coarsens it", () => {
    const stamps: StateStamps = { local: { lifetime: null, epoch: null, rows: { d: { state: "idle", at: 4000, terminal: "d:term" } } } };
    const done = pane("d", { agent: "codex", agent_status: "done" });
    const rows = trackedAgents([machine("local", "connected", snapshot([done]))], ctx(stamps));
    expect(rows[0]).toMatchObject({ state: "done", since: 4000 });
  });

  it("marks the finish by epoch and id, so a new value flashes once", () => {
    const finished = pane("f", { agent: "claude", agent_status: "done", finish_id: 3 });
    const unfinished = pane("u", { agent: "claude", agent_status: "working", finish_id: 3 });
    const noEpoch = snapshot([unfinished]);
    const rows = trackedAgents([machine("local", "connected", snapshot([finished], [], [workspace("w1", "Project")], "e9")), machine("remote", "connected", noEpoch)], ctx());
    expect(rows.find((row) => row.key === "local/f")?.finish).toBe("e9/3");
    expect(rows.find((row) => row.key === "remote/u")?.finish).toBeNull();
  });

  it("links a row to a shown parent on the same PC, and to none gone, self or other-PC", () => {
    const lead = pane("t1", { agent: "claude", agent_status: "working" });
    const helper = pane("t2", { agent: "codex", agent_status: "working", parent_pane_id: "t1" });
    const grandchild = pane("t3", { agent: "codex", agent_status: "idle", parent_pane_id: "t2" });
    const orphan = pane("t4", { agent: "codex", agent_status: "idle", parent_pane_id: "gone" });
    const self = pane("t5", { agent: "codex", agent_status: "idle", parent_pane_id: "t5" });
    const remoteLead = pane("t1", { agent: "claude", agent_status: "idle" });
    const rows = trackedAgents([
      machine("local", "connected", snapshot([lead, helper, grandchild, orphan, self])),
      machine("remote", "connected", snapshot([remoteLead])),
    ], ctx());
    const parent = (key: string) => rows.find((row) => row.key === key)?.parent;
    expect(parent("local/t2")).toBe("local/t1");
    expect(parent("local/t3")).toBe("local/t2");
    expect(parent("local/t4")).toBeNull(); // a parent that is not shown is no link
    expect(parent("local/t5")).toBeNull();
    expect(parent("remote/t1")).toBeNull(); // not "local/t1"
  });

  it("shows the hc-other workspace like any other, clustered by its id", () => {
    const placed = pane("p1", { agent: "codex", agent_status: "working" });
    const stray = pane("t9", { workspace_id: HC_OTHER_WORKSPACE_ID, tab_id: `${HC_OTHER_WORKSPACE_ID}:t9`, title: "vim" });
    const snap = snapshot([placed, stray], [], [workspace("w1", "Project"), workspace(HC_OTHER_WORKSPACE_ID, "Other terminals")]);
    const rows = trackedAgents([machine("local", "connected", snap)], ctx());
    const other = rows.find((row) => row.paneId === "t9");
    expect(other).toMatchObject({ workspace: "Other terminals", cluster: `local/${HC_OTHER_WORKSPACE_ID}`, state: "none" });
    expect(rows.find((row) => row.paneId === "p1")?.cluster).toBe("local/w1");
  });

  it("names the PC on every row only when more than one is shown, and skips a PC that is not connected", () => {
    const one = trackedAgents([machine("local", "connected", snapshot([pane("a", { agent: "codex" })]))], ctx());
    expect(one[0]?.machine).toBeNull();
    const two = trackedAgents([
      machine("local", "connected", snapshot([pane("a", { agent: "codex" })]), "This PC"),
      machine("remote", "connected", snapshot([pane("b", { agent: "claude" })]), "VPS"),
      machine("away", "disconnected", snapshot([pane("c", { agent: "claude" })]), "Away"),
      machine("empty", "connected", null, "Empty"),
    ], ctx());
    expect(two.map((row) => [row.key, row.machine])).toEqual([["local/a", "This PC"], ["remote/b", "VPS"]]);
  });
});
