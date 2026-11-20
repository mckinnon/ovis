import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Where agent tracking's Agents tab sits in the tab strip, and whether it was closed. The tab is
 * Ovis's own, not herdr's, so this browser keeps it (one place for every workspace's strip): `at`
 * is how many herdr tabs come before it, drawn no further than the strip's end. Opening tracking
 * any other way (palette, sidebar, More) brings a closed tab back.
 */
export interface TrackingTabPlace { at: number; closed: boolean }

const KEY = "ovis:tracking-tab";
export const TRACKING_TAB_AT_REST: TrackingTabPlace = { at: 0, closed: false };

export function parseTrackingTab(stored: string | null): TrackingTabPlace {
  if (stored === null) return TRACKING_TAB_AT_REST;
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== "object" || value === null) return TRACKING_TAB_AT_REST;
    const { at, closed } = value as Record<string, unknown>;
    return { at: typeof at === "number" && Number.isInteger(at) && at >= 0 ? at : 0, closed: closed === true };
  } catch {
    return TRACKING_TAB_AT_REST;
  }
}

const listeners = new Set<() => void>();
let cache: { raw: string | null; place: TrackingTabPlace } = { raw: null, place: TRACKING_TAB_AT_REST };

function read(): TrackingTabPlace {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(KEY); } catch { /* private mode: the defaults */ }
  if (raw !== cache.raw) cache = { raw, place: parseTrackingTab(raw) };
  return cache.place;
}

export function storeTrackingTab(place: TrackingTabPlace): void {
  const raw = JSON.stringify({ at: Math.max(0, Math.floor(place.at)), closed: place.closed });
  try { window.localStorage.setItem(KEY, raw); } catch { /* private mode: kept for this page only */ }
  cache = { raw, place: parseTrackingTab(raw) };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => { if (event.key === KEY) listener(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

export function useTrackingTab(): TrackingTabPlace {
  return useSyncExternalStore(subscribe, read, () => TRACKING_TAB_AT_REST);
}

/** the place, and a closed tab brought back when tracking opens (on the way in only: closing the tab
 *  while it is open leaves tracking in the same click) */
export function useTrackingTabPlace(trackingOn: boolean): TrackingTabPlace {
  const place = useTrackingTab();
  const wasOn = useRef(trackingOn);
  useEffect(() => {
    const entered = trackingOn && !wasOn.current;
    wasOn.current = trackingOn;
    if (entered && place.closed) storeTrackingTab({ ...place, closed: false });
  }, [trackingOn, place]);
  return place;
}
