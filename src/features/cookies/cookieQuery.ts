/**
 * Core logic for querying the browser's cookie jar.
 * Only import this from the background service worker — chrome.cookies is a
 * privileged API not available to content scripts or popups
 */

import { getDomain } from "tldts";
import type { CookieInfo, CookieQueryResult } from "./types";
import { getThirdPartyOrigins } from "./thirdPartyDomains";
import { isSecurityCookie } from "./securityCookies";
import { lookupTrackerCategory } from "./trackerLookup";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// How long to wait for a single chrome.cookies.getAll call before giving up.
// The cookie store can be locked by heavy writes, causing reads to stall indefinitely
const COOKIES_GETALL_TIMEOUT_MS = 4000;

// Return type for getAllWithTimeout — separates a real empty result from a timeout
interface GetAllResult {
  cookies: chrome.cookies.Cookie[];
  timedOut: boolean;
}

/**
 * Wraps chrome.cookies.getAll with a timeout so a stalled cookie-store lock
 * can't hang the caller forever. Returns timedOut: true if the deadline is exceeded
 */
function getAllWithTimeout(details: chrome.cookies.GetAllDetails): Promise<GetAllResult> {
  return Promise.race([
    chrome.cookies.getAll(details).then((cookies) => ({ cookies, timedOut: false })),
    new Promise<GetAllResult>((resolve) =>
      setTimeout(() => resolve({ cookies: [], timedOut: true }), COOKIES_GETALL_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Formats a Unix timestamp (seconds) into a readable date string.
 * Returns "Session" for cookies with no expiry set
 */
function formatExpiry(expirationDate: number | undefined): string {
  if (expirationDate === undefined) {
    return "Session";
  }
  const date = new Date(expirationDate * 1000); // convert seconds → milliseconds
  return date.toISOString().split("T")[0]; // "YYYY-MM-DD"
}

/**
 * Maps a raw chrome.cookies.Cookie to a CookieInfo, using the page URL for
 * the third-party check. When the caller already knows whether a cookie is
 * third-party (because it came from a third-party origin query), they should
 * override the isThirdParty field after calling this
 */
function mapCookie(c: chrome.cookies.Cookie, pageUrl: string): CookieInfo {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expirationDate: c.expirationDate ?? null,
    expiresFormatted: formatExpiry(c.expirationDate),
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    isThirdParty: isThirdPartyCookieDomain(c.domain, pageUrl),
    isSecurityCookie: isSecurityCookie(c.name, c.domain),
    trackerCategory: lookupTrackerCategory(c.domain),
  };
}

/**
 * Determines whether a cookie's domain differs from the page's registered domain.
 *
 * Uses the Public Suffix List (via `tldts`) to extract the eTLD+1 from both,
 * correctly handling multi-part TLDs like ".co.uk" or ".com.au".
 *
 * Examples:
 *   cookie ".doubleclick.net"  on "www.example.com"  → third-party ✓
 *   cookie ".example.co.uk"   on "shop.example.co.uk" → first-party ✓
 */
function isThirdPartyCookieDomain(cookieDomain: string, pageUrl: string): boolean {
  try {
    const pageHostname = new URL(pageUrl).hostname;
    const cleanCookieDomain = cookieDomain.replace(/^\./, ""); // strip leading dot
    const pageRegistered = getDomain(pageHostname);
    const cookieRegistered = getDomain(cleanCookieDomain);
    if (pageRegistered === null || cookieRegistered === null) {
      return false;
    }
    return pageRegistered !== cookieRegistered;
  } 
  catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Queries the browser cookie jar for all cookies visible to the given URL,
 * plus cookies from any third-party origins observed via webRequest for this tab.
 *
 * Two queries are needed because chrome.cookies.getAll({ url }) only returns
 * cookies whose domain matches the page URL (first-party). Third-party tracker
 * cookies (e.g. .doubleclick.net) are stored under their own domain and require
 * a separate getAll call per observed origin.
 *
 * @param pageUrl - Full URL of the current page.
 * @param tabId   - Chrome tab ID, used to look up observed third-party origins
 */
export async function queryCookiesWithThirdParty(
  pageUrl: string,
  tabId: number,
): Promise<CookieQueryResult> {
  // First-party cookies — all match the page domain, so isThirdParty is false
  const { cookies: rawFirstParty, timedOut: firstPartyTimedOut } = await getAllWithTimeout({ url: pageUrl });
  const firstPartyCookies: CookieInfo[] = rawFirstParty.map((c) => ({
    ...mapCookie(c, pageUrl),
    isThirdParty: false,
  }));

  // Third-party cookies — one getAll call per observed third-party origin.
  // Merges current-navigation origins (in-memory) with origins persisted from
  // previous visits to this site, so cached second-visits still see all cookies
  const origins = getThirdPartyOrigins(tabId);
  const pageRegisteredDomain = getDomain(new URL(pageUrl).hostname);
  let persistedOrigins: string[] = [];
  if (pageRegisteredDomain) {
    const storageKey = `origins_domain_${pageRegisteredDomain}`;
    const stored = await chrome.storage.session.get(storageKey).catch(() => ({}));
    persistedOrigins = ((stored as Record<string, unknown>)[storageKey] as string[]) ?? [];
  }
  const allOrigins = [...new Set([...origins, ...persistedOrigins])];
  const thirdPartyResults = await Promise.all(
    allOrigins.map(async (origin) => {
      const { cookies: raw, timedOut } = await getAllWithTimeout({ url: origin });
      return {
        cookies: raw.map((c): CookieInfo => ({
          ...mapCookie(c, pageUrl),
          isThirdParty: true,
        })),
        timedOut,
      };
    }),
  );

  const timedOut = firstPartyTimedOut || thirdPartyResults.some((r) => r.timedOut);

  // Merge, deduplicating on (name, domain) — first-party entry wins if both exist
  const seen = new Set<string>();
  const allCookies: CookieInfo[] = [];
  for (const c of [...firstPartyCookies, ...thirdPartyResults.flatMap((r) => r.cookies)]) {
    const key = `${c.name}|${c.domain}`;
    if (!seen.has(key)) {
      seen.add(key);
      allCookies.push(c);
    }
  }

  return { cookies: allCookies, queriedAt: new Date().toISOString(), timedOut };
}

