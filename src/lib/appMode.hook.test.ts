import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useTrackingMode, type TrackingMode } from "./appMode.ts";
import { linksSomewhere, NAV_KEY, readLink } from "./deepLink.ts";
import { SEEN_KEY } from "./historyKeys.ts";
import { pageStartsInInbox, useInboxMode, type InboxMode } from "./inboxMode.ts";

describe("useTrackingMode", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let tracking: TrackingMode;
  let inbox: InboxMode;
  let writes: string[];
  let loadWrites: string[];
  let entries: Array<{ state: unknown; url: URL }>;
  let index: number;
  let listeners: Array<{ type: string; listener: (event: Event) => void }>;
  let navigation: string | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    writes = [];
    listeners = [];
    navigation = "navigate";
    const write = (method: "pushState" | "replaceState") => (state: unknown, _unused: string, url?: string): void => {
      const entry = { state, url: url === undefined ? entries[index]!.url : new URL(url, entries[index]!.url) };
      if (method === "pushState") { entries.splice(index + 1); entries.push(entry); index += 1; } else entries[index] = entry;
      writes.push(`${method} ${index} ${entry.url.search}${entry.url.hash}`);
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      get location() { return entries[index]!.url; },
      performance: { getEntriesByType: (kind: string) => kind === "navigation" && navigation !== undefined ? [{ type: navigation }] : [] },
      history: {
        get state() { return entries[index]!.state; },
        pushState: write("pushState"), replaceState: write("replaceState"),
        go: (steps: number): void => {
          index += steps;
          let stopped = false;
          const event = Object.assign(new Event("popstate"), { state: entries[index]!.state, stopImmediatePropagation: () => { stopped = true; } });
          for (const { type, listener } of [...listeners]) { if (type === "popstate" && !stopped) listener(event); }
        },
      },
      addEventListener: (type: string, listener: (event: Event) => void) => { listeners.push({ type, listener }); },
      removeEventListener: (type: string, listener: (event: Event) => void) => { listeners = listeners.filter((other) => other.type !== type || other.listener !== listener); },
    } });
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

  async function mount(addresses: string[], both = false, phoneInbox = false): Promise<void> {
    entries = addresses.map((address) => ({ state: null, url: new URL(`http://localhost:7317${address}`) }));
    index = entries.length - 1;
    const search = entries[index]!.url.search;
    const link = linksSomewhere(search) ? readLink(search) : null;
    function Probe() {
      // the shell's own order (App.tsx): the inbox's hook first, then tracking's
      if (both) inbox = useInboxMode({ startsIn: () => pageStartsInInbox(phoneInbox, true, link) });
      tracking = useTrackingMode();
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe)); });
    loadWrites = writes;
    writes = [];
  }
  const back = (): Promise<void> => act(async () => { window.history.go(-1); });
  const forward = (): Promise<void> => act(async () => { window.history.go(1); });
  const searches = (): string[] => entries.map((entry) => entry.url.search);

  it("is off on the app's own address and on the inbox's, and on on its own", async () => {
    await mount(["/?ws=w1-api&pane=p1&view=chat"]);
    expect([tracking.on, tracking.at()]).toEqual([false, false]);
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;

    await mount(["/?app=inbox"]);
    expect([tracking.on, tracking.at()]).toEqual([false, false]);
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;

    await mount(["/?app=tracking"]);
    expect([tracking.on, tracking.at()]).toEqual([true, true]);
  });

  it("marks the entry the page loaded on once, however many of the mode's hooks the shell mounts", async () => {
    await mount(["/?pane=p1"], true);
    expect(loadWrites).toEqual(["replaceState 0 ?pane=p1"]);
    expect(entries[0]!.state).toEqual({ [SEEN_KEY]: true });
  });

  it("enters by one entry that keeps the address's other parameters, and Back and Forward follow it", async () => {
    await mount(["/?ws=w1-api&pane=p1&view=chat"]);

    await act(async () => { tracking.go(); });
    expect(tracking.on).toBe(true);
    expect(writes).toEqual(["pushState 1 ?ws=w1-api&pane=p1&view=chat&app=tracking"]);
    expect(entries[1]!.state).toEqual({ [NAV_KEY]: true });

    await back();
    expect([tracking.on, tracking.at()]).toEqual([false, false]);
    await forward();
    expect([tracking.on, tracking.at()]).toEqual([true, true]);
    expect(writes).toHaveLength(1);
  });

  it("leaves by one entry, and Back returns to the mode", async () => {
    await mount(["/?app=tracking&ws=w1-api&pane=p1&view=chat"]);

    await act(async () => { tracking.leave(); });
    expect(tracking.on).toBe(false);
    expect(writes).toEqual(["pushState 1 ?ws=w1-api&pane=p1&view=chat"]);

    await back();
    expect(tracking.on).toBe(true);
    expect(searches()).toEqual(["?app=tracking&ws=w1-api&pane=p1&view=chat", "?ws=w1-api&pane=p1&view=chat"]);
  });

  it("goes in and out by one entry each, and pushes nothing for the mode the address is already in", async () => {
    await mount(["/?pane=p1"]);
    await act(async () => { tracking.go(); });
    expect(tracking.on).toBe(true);
    await act(async () => { tracking.go(); });
    expect(tracking.on).toBe(false);
    expect(searches()).toEqual(["?pane=p1", "?pane=p1&app=tracking", "?pane=p1"]);
    expect(writes).toHaveLength(2);

    await act(async () => { tracking.leave(); });
    expect(writes).toHaveLength(2);

    await act(async () => { tracking.go(); });
    expect(tracking.on).toBe(true);
    expect(searches().at(-1)).toBe("?pane=p1&app=tracking");
    expect(writes).toHaveLength(3);
  });

  it("leaves the inbox where entering tracking finds it, and the other way round, on the one parameter", async () => {
    await mount(["/?app=inbox&pane=p1"], true);
    expect([inbox.on, tracking.on]).toEqual([true, false]);

    await act(async () => { tracking.go(); });
    expect([inbox.on, tracking.on]).toEqual([false, true]);
    expect(searches().at(-1)).toBe("?app=tracking&pane=p1");
    expect(writes).toEqual(["pushState 1 ?app=tracking&pane=p1"]);

    await act(async () => { inbox.enter(); });
    expect([inbox.on, tracking.on]).toEqual([true, false]);
    expect(searches().at(-1)).toBe("?app=inbox&pane=p1");

    await back();
    expect([inbox.on, tracking.on]).toEqual([false, true]);
    await back();
    expect([inbox.on, tracking.on]).toEqual([true, false]);
  });

  it("keeps a fresh tracking address over a phone's inbox default", async () => {
    await mount(["/?app=tracking"], true, true);
    expect([inbox.on, tracking.on]).toEqual([false, true]);
    expect(searches()).toEqual(["?app=tracking"]);
    expect(entries[0]!.state).toEqual({ [SEEN_KEY]: true });
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;

    await mount(["/?app=tracking&pane=p1&view=chat"], true, true);
    expect([inbox.on, tracking.on]).toEqual([false, true]);
    expect(searches()).toEqual(["?app=tracking&pane=p1&view=chat"]);
  });

  it("still starts a phone that asks for it in the inbox where the address names no mode", async () => {
    await mount(["/?pane=p1&view=chat"], true, true);
    expect([inbox.on, tracking.on]).toEqual([true, false]);
    expect(searches()).toEqual(["?pane=p1&view=chat&app=inbox"]);
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;

    await mount(["/"], true, true);
    expect([inbox.on, tracking.on]).toEqual([true, false]);
    expect(searches()).toEqual(["?app=inbox"]);
  });

  it("starts neither mode on a reload or on a step through the history, whatever the phone asks for", async () => {
    navigation = "reload";
    await mount(["/?app=tracking&pane=p1"], true, true);
    expect([inbox.on, tracking.on]).toEqual([false, true]);
    expect(searches()).toEqual(["?app=tracking&pane=p1"]);
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;

    navigation = "back_forward";
    await mount(["/?pane=p1&view=chat"], true, true);
    expect([inbox.on, tracking.on]).toEqual([false, false]);
    expect(searches()).toEqual(["?pane=p1&view=chat"]);
  });

  it("says where the address is before React has drawn it", async () => {
    await mount(["/?pane=p1", "/?app=tracking"]);
    let heard: boolean[] = [];
    listeners.unshift({ type: "popstate", listener: () => { heard = [tracking.on, tracking.at()]; } });

    await back();

    expect(heard).toEqual([true, false]);
    expect(tracking.on).toBe(false);
  });

  it("writes the mode into the hosted shell's fragment", async () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ getAttribute: () => "relay" }), addEventListener: () => {}, removeEventListener: () => {} } });
    const scope = `/s/${"ab".repeat(16)}/`;
    await mount([`${scope}#pane=p1`]);
    expect(tracking.on).toBe(false);

    await act(async () => { tracking.go(); });

    expect(writes).toEqual(["pushState 1 #pane=p1&app=tracking"]);
    expect([tracking.on, tracking.at()]).toEqual([true, true]);
  });
});
