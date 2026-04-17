/**
 * Tracks which third-party origins are contacted by each tab, using the
 * webRequest API. The background service worker records origins here as
 * requests fire; the cookie query layer reads them back to fetch cookies
 * for each observed third-party domain.
 *
 * Stored in chrome.storage.session (cleared on browser restart, keyed by
 * tabId) to avoid persisting stale data across sessions
 */

import { getDomain } from "tldts";

function storageKey(tabId: number): string {
  return `tporigins_${tabId}`;
}

/**
 * Adds a third-party origin to the set observed for this tab.
 * Returns true if the origin was newly added, false if already present
 */
export async function recordThirdPartyOrigin(tabId: number, origin: string): Promise<boolean> {
  const key = storageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const origins: string[] = stored[key] ?? [];
  if (origins.includes(origin)) {
    return false;
  }
  await chrome.storage.session.set({ [key]: [...origins, origin] });
  return true;
}

/**
 * Returns all third-party origins recorded for a tab, or [] if none
 */
export async function getThirdPartyOrigins(tabId: number): Promise<string[]> {
  const key = storageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] ?? [];
}

/**
 * Clears the third-party origin list for a tab.
 * Called at the start of each navigation so stale origins don't bleed
 * into the next page, and when a tab is closed to free storage
 */
export async function clearThirdPartyOrigins(tabId: number): Promise<void> {
  await chrome.storage.session.remove(storageKey(tabId));
}

/**
 * Returns true if the request URL belongs to a different registered domain
 * than the initiator origin (the page that triggered the request).
 * Uses the Public Suffix List via tldts to handle multi-part TLDs correctly
 */
export function isThirdPartyRequest(requestUrl: string, initiatorOrigin: string): boolean {
  try {
    const reqDomain = getDomain(new URL(requestUrl).hostname);
    const initDomain = getDomain(new URL(initiatorOrigin).hostname);
    if (!reqDomain || !initDomain) {
      return false;
    }
    return reqDomain !== initDomain;
  } 
  catch {
    return false;
  }
}
