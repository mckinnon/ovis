/**
 * Which full-area mode the app is in: the classic shell, the agent inbox or agent tracking. One
 * `app` parameter of the page's address carries it, and lib/deepLink.ts leaves that parameter in
 * place while the app moves between panes (it is none of deepLink's OWN keys), so a reload, a
 * link, Back and Forward agree on the mode. The modes are values of the one parameter, so entering
 * one leaves the other: every hook here reads the address, and a write one of them makes tells the
 * others to read it again.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { NAV_KEY } from "./deepLink.ts";
import { SEEN_KEY } from "./historyKeys.ts";
import { pageAddress, pageSearch } from "./pageQuery.ts";

export type AppMode = "classic" | "inbox" | "tracking";

/** A mode with a view of its own in the pane area's place. */
export type OwnMode = Exclude<AppMode, "classic">;

const PARAM = "app";

/** The mode the address names: `classic` for any value that is not one of ours. */
export function modeAddress(search: string): AppMode {
  const value = new URLSearchParams(search).get(PARAM);
  return value === "inbox" || value === "tracking" ? value : "classic";
}

/**
 * The address with `mode` in it, every other parameter left as it was. Leaving the modes drops the
 * parameter only where it holds one of theirs: a value another build put there is not ours to take
 * away, and rides along as it always did.
 */
export function withModeAddress(search: string, mode: AppMode): string {
  const query = new URLSearchParams(search);
  if (mode === "classic") {
    if (modeAddress(search) !== "classic") query.delete(PARAM);
  } else query.set(PARAM, mode);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** One mode's word to lib/useAddressBar.ts: whether it is on, and whether an address lands in it. */
export interface AppModeSlot {
  on: boolean;
  lands(): boolean;
}

/**
 * The mark `leaveToOpen` puts on the entry it pushes: leaving a mode to open something else is one
 * navigation, so lib/useAddressBar.ts replaces this entry with the selection's own address instead
 * of pushing a second entry beside it. Without it, opening a pane from tracking costs two Backs:
 * one onto the pane the mode was left on, and one more into the mode.
 */
export const MODE_EXIT_KEY = "ovis:mode-exit";

/** Whether a history entry is a mode's exit still waiting for the selection that follows it. */
export function modeExitEntry(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>)[MODE_EXIT_KEY] === true;
}

/** The entry's state without the exit mark. */
export function withoutModeExit(state: unknown): unknown {
  if (!modeExitEntry(state)) return state;
  const { [MODE_EXIT_KEY]: _mark, ...rest } = state as Record<string, unknown>;
  return rest;
}

/**
 * Takes this entry's exit mark, clearing it from the entry: only the address write right after the
 * exit takes the entry over, so a navigation of its own later still pushes one. Reading and clearing
 * are one step because an effect that returns before it writes must not leave the mark for a write
 * that has nothing to do with the exit.
 */
export function takeModeExit(): boolean {
  const state = window.history.state;
  if (!modeExitEntry(state)) return false;
  window.history.replaceState(withoutModeExit(state), "");
  return true;
}

/** `Array.isArray` does not narrow a readonly array, so a slot is told from a list of them here. */
function isSlot(mode: AppModeSlot | readonly AppModeSlot[]): mode is AppModeSlot {
  return !Array.isArray(mode);
}

/** The slots of a shell that offers one mode or several, as one list. */
export function modeSlots(mode: AppModeSlot | readonly AppModeSlot[] | undefined): readonly AppModeSlot[] {
  if (mode === undefined) return [];
  return isSlot(mode) ? [mode] : mode;
}

/**
 * The hooks of both modes, told of a write any of them makes, so the one the shell did not ask
 * draws what the address now says.
 */
const hearers = new Set<() => void>();

function announce(): void {
  for (const hear of [...hearers]) hear();
}

export interface AppModeState {
  /** whether this mode is on, as of the last draw */
  on: boolean;
  /** whether the address says this mode, read now: what a popstate listener hears before React draws */
  at(): boolean;
  enter(): void;
  leave(): void;
  /**
   * Leaves the mode as one step of opening something else: the entry is marked (MODE_EXIT_KEY) so
   * the selection's own address write takes it over, and Back from there returns to the mode.
   */
  leaveToOpen(): void;
  /** one ref for the shell's blocked drawer, set from the mode the page loads in */
  drawerBlocked: RefObject<boolean>;
}

/**
 * `mode`'s state, in the address and in the history. `startsIn` says a device starts in the mode
 * whatever its address, which only the inbox asks (Settings → Start in the agent inbox on a phone).
 */
export function useAppMode(mode: OwnMode, { startsIn }: { startsIn?: () => boolean } = {}): AppModeState {
  const [starts] = useState(() => startsIn?.() === true);
  const [on, setOn] = useState(() => starts || modeAddress(pageSearch()) === mode);
  const drawerBlocked = useRef(on);
  useEffect(() => {
    const address = starts && modeAddress(pageSearch()) !== mode ? pageAddress(window.location.pathname, withModeAddress(pageSearch(), mode), window.location.hash) : undefined;
    /**
     * An entry the app has stood on carries a state (freshNavigation, lib/inboxMode.ts): the one the
     * page loaded on from here, and one left without a state since (the auth link's own replace, a
     * mode's, a fragment typed into the address) by the time the page is hidden, which comes before
     * the browser can discard the tab or close with it.
     */
    const seen = (): void => { if (window.history.state === null) window.history.replaceState({ [SEEN_KEY]: true }, ""); };
    const hidden = (): void => { if (document.visibilityState === "hidden") seen(); };
    if (address !== undefined) window.history.replaceState(window.history.state ?? { [SEEN_KEY]: true }, "", address);
    else seen();
    window.addEventListener("pagehide", seen);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", seen);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", hidden);
    };
  }, [mode, starts]);
  useEffect(() => {
    const read = (): void => { setOn(modeAddress(pageSearch()) === mode); };
    window.addEventListener("popstate", read);
    hearers.add(read);
    return () => {
      window.removeEventListener("popstate", read);
      hearers.delete(read);
    };
  }, [mode]);
  const go = useCallback((next: boolean, opening: boolean): void => {
    const search = withModeAddress(pageSearch(), next ? mode : "classic");
    if (search !== pageSearch()) {
      const state = opening ? { [NAV_KEY]: true, [MODE_EXIT_KEY]: true } : { [NAV_KEY]: true };
      window.history.pushState(state, "", pageAddress(window.location.pathname, search, window.location.hash));
    }
    setOn(next);
    announce();
  }, [mode]);
  const enter = useCallback((): void => go(true, false), [go]);
  const leave = useCallback((): void => go(false, false), [go]);
  const leaveToOpen = useCallback((): void => go(false, true), [go]);
  const at = useCallback((): boolean => modeAddress(pageSearch()) === mode, [mode]);
  return { on, at, enter, leave, leaveToOpen, drawerBlocked };
}

export interface TrackingMode {
  on: boolean;
  at(): boolean;
  /** enters the mode where it is off and leaves it where it is on, as the shell's `go` does for the inbox */
  go(): void;
  leave(): void;
  /** leaves the mode to open a pane: one history entry for the two, so one Back returns here */
  leaveToOpen(): void;
}

/** Agent tracking: the mode's address, its history discipline and one way in and out. */
export function useTrackingMode(): TrackingMode {
  const { on, at, enter, leave, leaveToOpen } = useAppMode("tracking");
  const go = useCallback((): void => { if (at()) leave(); else enter(); }, [at, enter, leave]);
  return { on, at, go, leave, leaveToOpen };
}
