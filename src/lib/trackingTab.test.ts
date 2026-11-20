import { describe, expect, it } from "bun:test";
import { parseTrackingTab, TRACKING_TAB_AT_REST } from "./trackingTab.ts";

describe("the Agents tab's stored place", () => {
  it("reads a place and a closed tab", () => {
    expect(parseTrackingTab(JSON.stringify({ at: 3, closed: true }))).toEqual({ at: 3, closed: true });
  });
  it("falls back to first and open on anything it cannot read", () => {
    for (const stored of [null, "", "nope", "[]", "null", JSON.stringify({ at: -1 }), JSON.stringify({ at: 1.5 }), JSON.stringify({ at: "2" })]) {
      expect(parseTrackingTab(stored)).toEqual(stored !== null && stored.startsWith("{") ? { ...TRACKING_TAB_AT_REST, closed: false } : TRACKING_TAB_AT_REST);
    }
  });
});
