/**
 * The agent inbox's end of the app's mode address (lib/appMode.ts): the inbox is one of the modes
 * the one `app` parameter names, and this file keeps the inbox's own words for it, plus where a
 * device that asks to start in the inbox starts.
 */
import { inboxStartsOpen } from "./agentInbox.ts";
import { modeAddress, useAppMode, withModeAddress, type AppMode, type AppModeState } from "./appMode.ts";
import type { AppLink } from "./deepLink.ts";
import { pageSearch } from "./pageQuery.ts";

export function inboxAddress(search: string): boolean {
  return modeAddress(search) === "inbox";
}

export function withInboxAddress(search: string, inbox: boolean): string {
  return withModeAddress(search, inbox ? "inbox" : "classic");
}

/**
 * The state stays with its entry over a reload and when the browser restores the tab or loads it
 * again after discarding it, which a browser may report as a navigation.
 */
export function freshNavigation(type: string | undefined, state: unknown): boolean {
  return type !== "reload" && type !== "back_forward" && state === null;
}

/** How the browser says this page was loaded: navigate, reload, back_forward or prerender; undefined where it does not say. */
export function pageNavigation(): string | undefined {
  const [entry] = window.performance?.getEntriesByType?.("navigation") ?? [];
  return (entry as { type?: string } | undefined)?.type;
}

export function paneAddressStartsInInbox(link: AppLink | null): boolean {
  return Boolean(link?.pane);
}

/**
 * Whether a device that asks to start in the inbox starts there. `addressed` is the mode the page's
 * own address names: an address that says where the app is — a fresh `?app=tracking` link, say —
 * wins over the setting, which says where a phone starts, not where it stays.
 */
export function startsInInbox(setting: boolean, phone: boolean, link: AppLink | null, fresh: boolean, addressed: AppMode = "classic"): boolean {
  return addressed === "classic" && setting && phone && fresh && (inboxStartsOpen(true, link) || paneAddressStartsInInbox(link));
}

export function pageStartsInInbox(setting: boolean, phone: boolean, link: AppLink | null): boolean {
  return startsInInbox(setting, phone, link, freshNavigation(pageNavigation(), window.history.state), modeAddress(pageSearch()));
}

export type InboxMode = AppModeState;

export function useInboxMode({ startsIn }: { startsIn?: () => boolean } = {}): InboxMode {
  return useAppMode("inbox", { startsIn });
}
