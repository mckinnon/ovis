import type { Machine } from "../../shared/machines.ts";
import type { AgentInfo, AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import { displayPaneTitle } from "../components/Sidebar.tsx";
import { agentGroup } from "./agentRoster.ts";
import { stampState, stateSince, type StateStamps } from "./agentStateSince.ts";
import { trackingTask } from "./agentTrackingNames.ts";
import { agentName } from "./runtimeMove.ts";
import { sidebarAgents } from "./sidebarAgents.ts";

export type TrackedState = "working" | "idle" | "done" | "blocked" | "none";

export interface TrackedAgent {
  key: string;              // unique across PCs: `${machineId}/${paneId}` (pane ids may be "w1:p1")
  machineId: string;
  paneId: string;
  label: string;            // the task: the pane's own name, less the workspace, folders, shell and agent names (trackingTask); may be "" for an agent
  app: string | null;       // agent id, e.g. "codex"; null for a plain terminal
  state: TrackedState;      // from activity.status / agentGroup, same as the sidebar
  message: string | null;   // pane.agent_message (blocked reason today)
  workspace: string;        // workspace label
  cluster: string;          // `${machineId}/${workspace_id}`: one cluster per workspace
  machine: string | null;   // PC label, only when more than one PC is shown, else null
  parent: string | null;    // key of the parent (parent_pane_id on the same machine), if shown
  since: number | null;     // epoch ms the current state began (agentStateSince), else null
  finish: string | null;    // finish_id/finish_epoch marker; a new value = flash "done" once
  model: string | null;     // the model its conversation last recorded; filled by the view (useAgentModels), null here
}

/**
 * What a row needs beyond the roster, read exactly as the agent sidebar reads it:
 * `status` is a `SidebarActivity.status` (src/lib/sidebarActivity.tsx:10-13, whose pane parameter
 * is a Pick HerdrPane satisfies), so the seen-aware word the sidebar draws is the word here: a
 * finish this device already read shows idle, and a turn's background work holds at "waiting",
 * which `agentGroup` folds into "working" as the sidebar's groups do (src/lib/agentRoster.ts:97).
 * `stamps` is the device's state-since memory from `useAgentStateStamps`
 * (src/lib/useAgentStateSince.ts:24), which `stateSince` reads; pass `{}` for none.
 * As in the sidebar (src/components/AgentSidebar.tsx:538,540), a pane of a PC that is not
 * connected has no live status at all, and such a PC contributes no rows.
 */
export interface TrackingContext {
  status(machineId: string, pane: HerdrPane): AgentStatus | undefined;
  stamps: StateStamps;
}

/** A pane's own name (AgentSidebar's rowTitle): its given label, else its agent's or its own title, else the pane's display title. */
function paneLabel(pane: HerdrPane, agent: AgentInfo | null): string {
  return pane.label?.trim() || agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
}

export function trackedAgents(machines: readonly Machine[], ctx: TrackingContext): TrackedAgent[] {
  const shown = machines.filter((machine) => machine.state === "connected" && machine.snapshot !== null);
  const several = shown.length > 1;
  const out: TrackedAgent[] = [];
  for (const machine of shown) {
    const snapshot = machine.snapshot!;
    const rows = new Map(sidebarAgents(snapshot).map((row) => [row.pane.pane_id, row]));
    const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    const agents = new Map(snapshot.agents.map((agent) => [agent.pane_id, agent]));
    const seen = new Set<string>();
    for (const pane of snapshot.panes) {
      if (seen.has(pane.pane_id)) continue;
      seen.add(pane.pane_id);
      const row = rows.get(pane.pane_id);
      const workspace = row?.workspace ?? workspaces.get(pane.workspace_id);
      const key = `${machine.id}/${pane.pane_id}`;
      const machineName = several ? machine.name : null;
      const cluster = `${machine.id}/${pane.workspace_id}`;
      const parent = pane.parent_pane_id !== undefined && pane.parent_pane_id !== pane.pane_id
        && snapshot.panes.some((candidate) => candidate.pane_id === pane.parent_pane_id)
        ? `${machine.id}/${pane.parent_pane_id}` : null;
      const finish = pane.finish_id !== undefined && snapshot.finish_epoch !== undefined
        ? `${snapshot.finish_epoch}/${pane.finish_id}` : null;
      // a pane the sidebar leaves out (a plain shell; one whose workspace the snapshot does not
      // name) still shows, as a plain terminal unless herdr names an agent for it
      const app = row?.canonicalAgent ?? (pane.agent?.trim() || null);
      const workspaceName = workspace?.label ?? pane.workspace_id;
      const names = app === null ? [] : [app, agentName(app), row?.agentLabel ?? ""];
      const label = trackingTask(paneLabel(pane, row?.agent ?? agents.get(pane.pane_id) ?? null), workspaceName, names);
      if (app === null) {
        // a plain terminal's first line is only its name: its pane id when its title was a shell's or a folder
        out.push({ key, machineId: machine.id, paneId: pane.pane_id, label: label || pane.pane_id, app, state: "none", message: null, workspace: workspaceName, cluster, machine: machineName, parent, since: null, finish, model: null });
        continue;
      }
      const group = agentGroup(ctx.status(machine.id, pane));
      out.push({
        key,
        machineId: machine.id,
        paneId: pane.pane_id,
        label,
        app,
        state: group,
        message: pane.agent_message ?? null,
        workspace: workspaceName,
        cluster,
        machine: machineName,
        parent,
        since: stateSince(ctx.stamps, machine.id, pane.pane_id, pane.terminal_id, stampState(group)),
        finish,
        model: null,
      });
    }
  }
  return out.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
