import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, useLayoutEffect, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";
import { MODE_EXIT_KEY, useTrackingMode, type TrackingMode } from "./appMode.ts";
import type { AppLink, CreateDraft } from "./deepLink.ts";
import type { SelectionMark } from "./selectionMark.ts";
import * as settingsHistory from "./settingsHistory.ts";
import * as sheetHistory from "./sheetHistory.ts";
import { useAddressBar } from "./useAddressBar.ts";

const loaded = { settings: { ...settingsHistory }, sheet: { ...sheetHistory } };
beforeAll(() => {
  mock.module("./settingsHistory.ts", () => ({ ...loaded.settings, settingsSteppedOff: () => false }));
  mock.module("./sheetHistory.ts", () => ({ ...loaded.sheet, sheetSteppedOff: () => false }));
});
afterAll(() => {
  mock.module("./settingsHistory.ts", () => loaded.settings);
  mock.module("./sheetHistory.ts", () => loaded.sheet);
});

type Params = Parameters<typeof useAddressBar>[0];
type Snapshot = NonNullable<Machine["snapshot"]>;

const P1 = "?ws=w1-api&pane=p1&view=chat";
const P2 = "?ws=w2-docs&pane=p2&view=chat";
const TRACKED = "?app=tracking";
/**
 * The address tracking is entered on: the pane the app was on, with `app` first, as linkSearch
 * re-sets the parameters it owns after the one it leaves alone (the inbox's thread reads the same).
 */
const tracked = (pane: string): string => `${TRACKED}&${pane.slice(1)}`;
const snapshot = {
  workspaces: [{ workspace_id: "w1", label: "api" }, { workspace_id: "w2", label: "docs" }],
  panes: [{ pane_id: "p1", workspace_id: "w1", focused: true }, { pane_id: "p2", workspace_id: "w2", focused: false }],
  layouts: [],
} as unknown as Snapshot;

describe("agent tracking in the history", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let paneId: string | null;
  let tracking: TrackingMode;
  let entries: Array<{ state: unknown; url: URL }>;
  let index: number;
  let listeners: Array<{ type: string; listener: (event: Event) => void }>;
  const refs = {
    selection: { current: { machineId: "local", paneId: null, generation: 0 } as SelectionMark },
    machines: { current: [] as Machine[] },
    selectTarget: { current: (_machineId: string, _paneId: string | null): void => {} },
    pendingFile: { current: null as string | null },
    pendingLink: { current: null as AppLink | null },
    pendingCreate: { current: null as CreateDraft | null },
    newSessionPending: { current: false },
    linkSince: { current: 0 },
    rosterSeq: { current: 0 },
    drawerOpen: { current: false } as RefObject<boolean>,
  };
  /** the inbox the shell also offers, closed throughout: tracking is what these tests move through */
  const inbox = { shown: false, enabled: false, show: () => {}, leave: () => {} };

  function Probe() {
    const mode = useTrackingMode();
    tracking = mode;
    const machine = { id: "local", name: "workstation", kind: "local", enabled: true, state: "connected", error: null, snapshot } as Machine;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId) as HerdrPane;
    refs.machines.current = [machine];
    useLayoutEffect(() => { refs.selection.current = { machineId: "local", paneId, generation: 0 }; }, [paneId]);
    useAddressBar({
      inbox, mode: [{ on: mode.on, lands: mode.at }],
      newSessionOpen: false, newSessionMachineId: "local", newFields: null, sidebarCollapsed: false, snapshot, selectedPaneId: paneId, selectedPane: pane,
      selectedWorkspace: snapshot.workspaces.find((workspace) => workspace.workspace_id === pane?.workspace_id) as HerdrWorkspace,
      selectedMachineId: "local", selectedMachine: machine, machines: refs.machines.current, machinesRef: refs.machines,
      viewing: null, leaveFile: () => false, restoreFile: () => {}, fileFromPop: () => 0, forgetLeftFiles: () => {}, openFile: () => {},
      locked: false, linkLanded: true, view: "chat", wideScreen: true, autoSelected: false, newTab: null,
      settingsOpen: false, settingsPage: null, settingsLinkPage: null, settingsLinkSection: null,
      pendingFile: refs.pendingFile, pendingLink: refs.pendingLink, pendingCreate: refs.pendingCreate, newSessionPending: refs.newSessionPending, linkSince: refs.linkSince, rosterSeq: refs.rosterSeq,
      selectTargetRef: refs.selectTarget, selectionRef: refs.selection,
      setLinkLanded: () => {}, setHeaderNote: () => {}, setNewSessionOpen: () => {},
    } as unknown as Params);
    return null;
  }
  const draw = (): void => { renderer?.update(createElement(Probe)); };

  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    listeners = [];
    refs.selectTarget.current = (_machineId, picked) => { if (picked !== null) { paneId = picked; draw(); } };
    const write = (method: "pushState" | "replaceState") => (state: unknown, _unused: string, url?: string): void => {
      const entry = { state, url: url === undefined ? entries[index]!.url : new URL(url, entries[index]!.url) };
      if (method === "pushState") { entries.splice(index + 1); entries.push(entry); index += 1; } else entries[index] = entry;
    };
    const go = (steps: number): void => {
      index += steps;
      const event = Object.assign(new Event("popstate"), { state: entries[index]!.state });
      for (const { type, listener } of [...listeners]) {
        if (type !== "popstate") continue;
        page.event = event;
        try { listener(event); } finally { page.event = undefined; }
      }
    };
    const page = {
      event: undefined as Event | undefined,
      get location() { return entries[index]!.url; },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      performance: { getEntriesByType: () => [] },
      history: { get state() { return entries[index]!.state; }, pushState: write("pushState"), replaceState: write("replaceState"), go, back: () => go(-1) },
      addEventListener: (type: string, listener: (event: Event) => void) => { listeners.push({ type, listener }); },
      removeEventListener: (type: string, listener: (event: Event) => void) => { listeners = listeners.filter((other) => other.type !== type || other.listener !== listener); },
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: page });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function open(addresses: string[], selected: string | null, state: unknown = null): Promise<void> {
    entries = addresses.map((search) => ({ state: null, url: new URL(`http://localhost:7317/${search}`) }));
    index = entries.length - 1;
    entries[index]!.state = state;
    paneId = selected;
    await act(async () => { renderer = create(createElement(Probe)); });
  }
  const addresses = (): string[] => entries.map((entry) => entry.url.search);
  const at = (): string => entries[index]!.url.search;
  const screen = (): string => `${tracking.on ? "tracking" : "app"}:${paneId}`;
  const enterTracking = (): Promise<void> => act(async () => { tracking.go(); });
  const closeTracking = (): Promise<void> => act(async () => { tracking.leave(); });
  /** what App's onOpen does: leave as one step of opening the pane (App.tsx, <AgentTracking onOpen>) */
  const openFromTracking = (picked: string): Promise<void> => act(async () => { tracking.leaveToOpen(); refs.selectTarget.current("local", picked); });
  const back = (): Promise<void> => act(async () => { window.history.go(-1); });

  it("enters from a pane by one entry that keeps the pane under it, and Back returns to the app", async () => {
    await open([P1], "p1");
    expect(screen()).toBe("app:p1");

    await enterTracking();
    expect(screen()).toBe("tracking:p1");
    expect(addresses()).toEqual([P1, tracked(P1)]);

    await back();
    expect(screen()).toBe("app:p1");
    expect(addresses()).toEqual([P1, tracked(P1)]);
  });

  it("opens another pane as one entry, so one Back returns to tracking and not to the pane it was left on", async () => {
    await open([P1], "p1");
    await enterTracking();

    await openFromTracking("p2");
    expect(screen()).toBe("app:p2");
    expect(addresses()).toEqual([P1, tracked(P1), P2]);

    await back();
    expect(screen()).toBe("tracking:p1");
    expect(at()).toBe(tracked(P1));
    await back();
    expect(screen()).toBe("app:p1");
  });

  it("takes the pane already selected with no entry of its own, and marks nothing that outlives it", async () => {
    await open([P1], "p1");
    await enterTracking();

    await openFromTracking("p1");
    expect(screen()).toBe("app:p1");
    expect(addresses()).toEqual([P1, tracked(P1), P1]);

    // the exit mark was spent on the write above, or there was none to spend: a navigation of its
    // own later is an entry of its own, as it always was
    await enterTracking();
    await openFromTracking("p2");
    expect(addresses()).toEqual([P1, tracked(P1), P1, tracked(P1), P2]);
  });

  it("leaves without opening onto the pane under it by an entry of its own, as the inbox does", async () => {
    await open([P1], "p1");
    await enterTracking();

    await closeTracking();
    expect(screen()).toBe("app:p1");
    expect(addresses()).toEqual([P1, tracked(P1), P1]);
    expect(entries[2]!.state).not.toHaveProperty(MODE_EXIT_KEY);

    await back();
    expect(screen()).toBe("tracking:p1");
  });

  it("spends the exit mark on the write that follows it, and on nothing else", async () => {
    await open([P1], "p1");
    await enterTracking();

    // leaving in order to open, with nothing to open: the exit entry stands and its mark is spent,
    // so an effect that has nothing to write does not leave the mark for a later navigation
    await act(async () => { tracking.leaveToOpen(); });
    expect(addresses()).toEqual([P1, tracked(P1), P1]);
    expect(entries[2]!.state).not.toHaveProperty(MODE_EXIT_KEY);

    await act(async () => { refs.selectTarget.current("local", "p2"); });
    expect(addresses()).toEqual([P1, tracked(P1), P1, P2]);
  });

  it("leaving and then choosing a pane as two gestures is two entries, as it always was", async () => {
    await open([P1], "p1");
    await enterTracking();

    await closeTracking();
    expect(addresses()).toEqual([P1, tracked(P1), P1]);
    await act(async () => { refs.selectTarget.current("local", "p2"); });
    expect(addresses()).toEqual([P1, tracked(P1), P1, P2]);
  });

  it("a reload on the pane tracking was left onto keeps the app, not the mode", async () => {
    await open([P1], "p1");
    await enterTracking();
    await openFromTracking("p2");
    const left = addresses();
    const stood = entries[index]!.state;
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;

    await open(left, "p2", stood);
    expect(screen()).toBe("app:p2");
    expect(addresses()).toEqual(left);
    expect(entries[index]!.state).not.toHaveProperty(MODE_EXIT_KEY);
  });
});
