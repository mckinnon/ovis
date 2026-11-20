import { describe, expect, it } from "bun:test";
import { modeAddress, modeExitEntry, modeSlots, withoutModeExit, withModeAddress, type AppModeSlot } from "./appMode.ts";
import { readLink } from "./deepLink.ts";
import { inboxAddress, startsInInbox, withInboxAddress } from "./inboxMode.ts";
import { pageAddress, pageSearch } from "./pageQuery.ts";

describe("the mode the address names", () => {
  it("is the app parameter's own values, and the classic app for anything else", () => {
    expect(modeAddress("?app=inbox")).toBe("inbox");
    expect(modeAddress("?app=tracking")).toBe("tracking");
    expect(modeAddress("?ws=w1-api&pane=p1&app=tracking&view=chat")).toBe("tracking");
    expect(modeAddress("")).toBe("classic");
    expect(modeAddress("?pane=p1")).toBe("classic");
    expect(modeAddress("?app=classic")).toBe("classic");
    expect(modeAddress("?app=other")).toBe("classic");
  });

  it("sets one mode in place of the other, keeping every other parameter as it was", () => {
    expect(withModeAddress("", "tracking")).toBe("?app=tracking");
    expect(withModeAddress("?ws=w1-api&pane=p1&view=chat", "tracking")).toBe("?ws=w1-api&pane=p1&view=chat&app=tracking");
    expect(withModeAddress("?app=inbox&pane=p1", "tracking")).toBe("?app=tracking&pane=p1");
    expect(withModeAddress("?app=tracking&pane=p1", "inbox")).toBe("?app=inbox&pane=p1");
    expect(withModeAddress("?app=tracking&pane=p1", "tracking")).toBe("?app=tracking&pane=p1");
  });

  it("leaves the classic app with no parameter of ours, and another build's value alone", () => {
    expect(withModeAddress("?app=tracking", "classic")).toBe("");
    expect(withModeAddress("?app=tracking&pane=p1", "classic")).toBe("?pane=p1");
    expect(withModeAddress("?app=inbox&pane=p1", "classic")).toBe("?pane=p1");
    expect(withModeAddress("?app=other&pane=p1", "classic")).toBe("?app=other&pane=p1");
    expect(withModeAddress("?pane=p1", "classic")).toBe("?pane=p1");
  });

  it("is what the inbox's own words for the address still say", () => {
    expect(inboxAddress("?app=inbox")).toBe(true);
    expect(inboxAddress("?app=tracking")).toBe(false);
    expect(inboxAddress("?app=inbox&pane=p1")).toBe(true);
    expect(withInboxAddress("?app=tracking&pane=p1", true)).toBe("?app=inbox&pane=p1");
    expect(withInboxAddress("?app=tracking&pane=p1", false)).toBe("?pane=p1");
    expect(withInboxAddress("?app=other&pane=p1", false)).toBe("?app=other&pane=p1");
    expect(withModeAddress(withInboxAddress("?pane=p1", true), "tracking")).toBe("?pane=p1&app=tracking");
  });

  it("rides in the hosted shell's fragment with the rest of the page's query", () => {
    const scope = `/s/${"ab".repeat(16)}/`;
    const address = pageAddress(scope, withModeAddress("?pane=p1", "tracking"), "", "relay");
    expect(address).toBe(`${scope}#pane=p1&app=tracking`);
    expect(modeAddress(pageSearch({ search: "", hash: new URL(address, "https://app.example").hash }, "relay"))).toBe("tracking");
  });
});

describe("the modes a shell offers the address bar", () => {
  const slot = (on: boolean, lands: boolean): AppModeSlot => ({ on, lands: () => lands });

  it("reads one slot, several, and a shell that offers none", () => {
    expect(modeSlots(undefined)).toEqual([]);
    const one = slot(true, false);
    expect(modeSlots(one)).toEqual([one]);
    const several = [slot(false, true), slot(true, false)];
    expect(modeSlots(several)).toEqual(several);
  });

  it("is on where any slot is, and lands where any slot says the address does", () => {
    expect(modeSlots([slot(false, false), slot(true, false)]).some((each) => each.on)).toBe(true);
    expect(modeSlots([slot(false, false), slot(false, false)]).some((each) => each.on)).toBe(false);
    expect(modeSlots([slot(false, false), slot(false, true)]).some((each) => each.lands())).toBe(true);
    expect(modeSlots([]).some((each) => each.lands())).toBe(false);
  });
});

describe("where a device that starts in the inbox starts", () => {
  const phone = true;

  it("still starts there on a fresh load of the app's own address or of a pane's", () => {
    expect(startsInInbox(true, phone, null, true)).toBe(true);
    expect(startsInInbox(true, phone, readLink("?pane=w1%3Ap1&view=chat"), true)).toBe(true);
  });

  it("gives an address that names a mode the say, so a fresh tracking link is not turned into the inbox", () => {
    expect(startsInInbox(true, phone, null, true, "tracking")).toBe(false);
    expect(startsInInbox(true, phone, readLink("?pane=w1%3Ap1&view=chat"), true, "tracking")).toBe(false);
    expect(startsInInbox(true, phone, readLink("?settings=appearance"), true, "tracking")).toBe(false);
    expect(startsInInbox(true, phone, null, true, "inbox")).toBe(false);
  });

  it("reads the mode it is given as classic by default, so what the setting did before it stands", () => {
    expect(startsInInbox(true, phone, null, true)).toBe(startsInInbox(true, phone, null, true, "classic"));
    expect(startsInInbox(true, phone, null, false, "tracking")).toBe(false);
    expect(startsInInbox(false, phone, null, true, "classic")).toBe(false);
  });
});

describe("the mark on an entry a mode left in order to open something", () => {
  it("is read only off an entry that carries it", () => {
    expect(modeExitEntry({ "ovis:mode-exit": true, "ovis:nav": true })).toBe(true);
    expect(modeExitEntry({ "ovis:mode-exit": false })).toBe(false);
    expect(modeExitEntry({ "ovis:nav": true })).toBe(false);
    expect(modeExitEntry(null)).toBe(false);
    expect(modeExitEntry(undefined)).toBe(false);
    expect(modeExitEntry("?app=tracking")).toBe(false);
  });

  it("comes off with every other key of the state left as it was, and off nothing unmarked", () => {
    expect(withoutModeExit({ "ovis:mode-exit": true, "ovis:nav": true })).toEqual({ "ovis:nav": true });
    expect(withoutModeExit({ "ovis:mode-exit": true })).toEqual({});
    const unmarked = { "ovis:nav": true };
    expect(withoutModeExit(unmarked)).toBe(unmarked);
    expect(withoutModeExit(null)).toBeNull();
  });
});
