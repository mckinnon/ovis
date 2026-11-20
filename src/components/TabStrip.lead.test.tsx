import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Radar } from "lucide-react";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { AppLayoutContext, appLayoutOf } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { TabStrip, type StripLead } from "./TabStrip.tsx";

/** agent tracking's tab (StripLead): Ovis's own tab before herdr's, which takes the selection while it is open */

const OVIS_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core", layout: { rename: true, split: true, move: true, arrange: true, worktrees: true } });
const workspace: WorkspaceInfo = { workspace_id: "w1", label: "w1", active_tab_id: "w1:t1", number: 1, tab_count: 2, pane_count: 2, focused: false, agent_status: "idle", worktree: null };
const pane = (tabId: string): PaneInfo => ({ pane_id: `${tabId}:p`, workspace_id: "w1", tab_id: tabId, terminal_id: `${tabId}:term`, revision: 1, focused: false, agent_status: "idle" });
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", workspaces: [workspace], layouts: [], agents: [],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "", number: 1, pane_count: 1, focused: true, agent_status: "idle" },
    { tab_id: "w1:t2", workspace_id: "w1", label: "", number: 2, pane_count: 1, focused: false, agent_status: "idle" },
  ],
  panes: [pane("w1:t1"), pane("w1:t2")],
};
const node = (): HTMLElement => ({
  isConnected: true, offsetWidth: 200, offsetHeight: 100, dataset: {}, scrollLeft: 0, scrollWidth: 0, clientWidth: 0,
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, closest: () => null,
  focus() {}, addEventListener() {}, removeEventListener() {},
}) as unknown as HTMLElement;

describe("agent tracking's tab in the tab strip", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "HTMLElement", "CSS", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    const media = { matches: false, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("HTMLElement", class HTMLElement {});
    define("CSS", { escape: (value: string) => value });
    define("ResizeObserver", class ResizeObserver { observe() {} disconnect() {} });
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, innerWidth: 1280, innerHeight: 800, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { visibilityState: "visible", activeElement: null, body: { nodeType: 1, children: [], createNodeMock: node }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function draw(lead: StripLead | undefined, picked: string[] = [], browserTabs = false): Promise<ReactTestInstance[]> {
    const tree = createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: OVIS_CORE },
      createElement(TabStrip, { snapshot, workspace, selectedPane: snapshot.panes[0]!, onSelectPane: (id: string) => { picked.push(id); }, onNewTab: () => {}, onNewTerminal: async () => {}, lead, browserTabs })));
    await act(async () => { if (renderer) renderer.update(tree); else renderer = create(tree, { createNodeMock: node }); });
    return renderer!.root.findAll((item) => item.type === "button" && item.props.role === "tab");
  }
  const lead = (selected: boolean, opened: string[], at = 0): StripLead => ({
    label: "Agents", icon: createElement(Radar), selected, at,
    onSelect: () => { opened.push("tracking"); }, onMove: (to) => { opened.push(`move ${to}`); }, onClose: () => { opened.push("close"); },
  });
  const order = (): string[] => renderer!.root.findAll((item) => item.type === "button" && item.props.role === "tab").map((tab) => tab.props["data-tab-id"] ?? "agents");

  it("comes first, unselected, and opens tracking when clicked", async () => {
    const opened: string[] = [];
    const tabs = await draw(lead(false, opened));
    expect(tabs.map((tab) => tab.props["aria-selected"])).toEqual([false, true, false]);
    expect(tabs[0]!.props.title).toBe("Agents");
    expect(tabs[0]!.props["data-tab-id"]).toBeUndefined();
    await act(async () => tabs[0]!.props.onClick());
    expect(opened).toEqual(["tracking"]);
  });

  it("takes the selection while tracking is open, and a herdr tab is still picked from it", async () => {
    const opened: string[] = [];
    const picked: string[] = [];
    const tabs = await draw(lead(true, opened), picked);
    expect(tabs.map((tab) => tab.props["aria-selected"])).toEqual([true, false, false]);
    expect(tabs.map((tab) => tab.props.tabIndex)).toEqual([0, -1, -1]);
    await act(async () => tabs[0]!.props.onClick());
    expect(opened).toEqual([]);
    await act(async () => tabs[1]!.props.onClick({ detail: 1, ctrlKey: false, currentTarget: node() }));
    expect(picked).toEqual(["w1:t1:p"]);
  });

  it("sits after as many herdr tabs as it is told, never past the end", async () => {
    await draw(lead(false, [], 1));
    expect(order()).toEqual(["w1:t1", "agents", "w1:t2"]);
    await draw(lead(false, [], 9));
    expect(order()).toEqual(["w1:t1", "w1:t2", "agents"]);
  });

  it("closes from its X and the middle button, as herdr's tabs do", async () => {
    const opened: string[] = [];
    await draw(lead(false, opened));
    const close = renderer!.root.findAll((item) => item.type === "button" && item.props.className === "tab-strip-close");
    expect(close).toHaveLength(0); // no X outside the header's browser-style row, like herdr's tabs there
    const tabs = renderer!.root.findAll((item) => item.type === "button" && item.props.role === "tab");
    await act(async () => tabs[0]!.props.onAuxClick({ button: 1, preventDefault() {} }));
    expect(opened).toEqual(["close"]);
    await draw(lead(false, opened), [], true);
    const x = renderer!.root.findAll((item) => item.type === "button" && item.props.className === "tab-strip-close" && item.props.title === "Close Agents");
    expect(x).toHaveLength(1);
    await act(async () => x[0]!.props.onClick());
    expect(opened).toEqual(["close", "close"]);
  });

  it("is not drawn without a lead, so herdr's tabs are the strip as before", async () => {
    const tabs = await draw(undefined);
    expect(tabs.map((tab) => tab.props["aria-selected"])).toEqual([true, false]);
  });
});
