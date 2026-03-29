/**
 * cookieQuery.ts
 *
 * Core logic for querying the browser's cookie jar.
 * Must only be imported from the background service worker, because
 * chrome.cookies is a privileged API not available to content scripts or popups.
 */

import { getDomain } from "tldts";
import type { CookieInfo, CookieQueryResult } from "./types";
import { getThirdPartyOrigins } from "./thirdPartyDomains";
import { isSecurityCookie } from "./securityCookies";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats a Unix timestamp (seconds) into a readable date string.
 * Returns "Session" for cookies with no expiry set.
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
 * override the isThirdParty field after calling this.
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
 * PLUS cookies from any third-party origins that were observed via webRequest
 * for this tab.
 *
 * WHY TWO QUERIES ARE NEEDED:
 * chrome.cookies.getAll({ url }) returns only cookies whose domain matches the
 * page URL — i.e. first-party cookies. Third-party tracker cookies (e.g. from
 * .doubleclick.net or .google-analytics.com) are stored under their own domain
 * and are never returned by a single-URL query. To surface them we track which
 * third-party origins are contacted via webRequest and query each one separately.
 *
 * @param pageUrl - Full URL of the current page.
 * @param tabId   - Chrome tab ID, used to look up observed third-party origins.
 */
export async function queryCookiesWithThirdParty(
  pageUrl: string,
  tabId: number,
): Promise<CookieQueryResult> {
  // First-party cookies — all match the page domain, so isThirdParty is false
  const rawFirstParty = await chrome.cookies.getAll({ url: pageUrl });
  const firstPartyCookies: CookieInfo[] = rawFirstParty.map((c) => ({
    ...mapCookie(c, pageUrl),
    isThirdParty: false,
  }));

  // Third-party cookies — one getAll call per observed third-party origin
  const origins = await getThirdPartyOrigins(tabId);
  const thirdPartyGroups = await Promise.all(
    origins.map(async (origin) => {
      const raw = await chrome.cookies.getAll({ url: origin });
      return raw.map((c): CookieInfo => ({
        ...mapCookie(c, pageUrl),
        isThirdParty: true,
      }));
    }),
  );

  // Merge, deduplicating on (name, domain) — first-party entry wins if both exist
  const seen = new Set<string>();
  const allCookies: CookieInfo[] = [];
  for (const c of [...firstPartyCookies, ...thirdPartyGroups.flat()]) {
    const key = `${c.name}|${c.domain}`;
    if (!seen.has(key)) {
      seen.add(key);
      allCookies.push(c);
    }
  }

  return { cookies: allCookies, queriedAt: new Date().toISOString() };
}
