/**
 * Builds a lookup table from disconnect.me's published tracker list.
 * Used to identify cookie domains that belong to known third-party trackers
 */

import { getDomain } from "tldts";
import trackersData from "../../data/trackers.json";

type TrackerList = Array<Record<string, Record<string, string[]>>>;
type Categories = Record<string, TrackerList>;

// Map from eTLD+1 (registered domain) → disconnect.me category name.
// Built once at module load from the full tracker list
const trackerDomainMap = new Map<string, string>();

for (const [category, trackerList] of Object.entries(trackersData.categories as unknown as Categories)) {
  for (const trackerEntry of trackerList) {
    for (const domainsByUrl of Object.values(trackerEntry)) {
      for (const domains of Object.values(domainsByUrl)) {
        for (const domain of domains) {
          const registered = getDomain(domain);
          if (registered) {
            trackerDomainMap.set(registered, category);
          }
        }
      }
    }
  }
}

/**
 * Returns the disconnect.me category name if the given cookie domain matches
 * any entry in the tracker database, or null if no match is found.
 * Subdomain matching is handled automatically by comparing eTLD+1 registered domains —
 * e.g. "sub.doubleclick.net" will match the "doubleclick.net" tracker entry
 */
export function lookupTrackerCategory(cookieDomain: string): string | null {
  const clean = cookieDomain.replace(/^\./, "");
  const registered = getDomain(clean);
  if (!registered) {
    return null;
  }
  return trackerDomainMap.get(registered) ?? null;
}
