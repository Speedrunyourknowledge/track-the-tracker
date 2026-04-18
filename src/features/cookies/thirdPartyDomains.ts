/**
 * Tracks third-party origins contacted by each tab via the webRequest API.
 * Origins are kept in an in-memory Map (same as tabAlerts / tabPostRequests)
 * so concurrent webRequest events don't race on chrome.storage writes
 */

import { getDomain } from "tldts";

// Keyed by tabId, stores the set of third-party origins seen during this page load
const thirdPartyOriginsMap = new Map<number, Set<string>>();

/**
 * Adds a third-party origin to the set observed for this tab.
 * Returns true if the origin was newly added, false if already present
 */
export function recordThirdPartyOrigin(tabId: number, origin: string): boolean {
  let origins = thirdPartyOriginsMap.get(tabId);
  if (!origins) {
    origins = new Set<string>();
    thirdPartyOriginsMap.set(tabId, origins);
  }
  if (origins.has(origin)) {
    return false;
  }
  origins.add(origin);
  return true;
}

/**
 * Returns all third-party origins recorded for a tab, or [] if none
 */
export function getThirdPartyOrigins(tabId: number): string[] {
  return [...(thirdPartyOriginsMap.get(tabId) ?? [])];
}

/**
 * Clears the third-party origin list for a tab.
 * Called at the start of each navigation so stale origins don't bleed
 * into the next page, and when a tab is closed to free storage
 */
export function clearThirdPartyOrigins(tabId: number): void {
  thirdPartyOriginsMap.delete(tabId);
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
