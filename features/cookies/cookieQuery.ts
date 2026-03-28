/**
 * cookieQuery.ts
 *
 * Core logic for querying the browser's cookie jar.
 * Must only be imported from the background service worker, because
 * chrome.cookies is a privileged API not available to content scripts or popups.
 */

import { getDomain } from "tldts";
import type { CookieInfo, CookieQueryResult } from "./types";

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
 * Determines whether a cookie is third-party relative to the given page URL.
 *
 * Uses the Public Suffix List (via `tldts`) to extract the registered domain
 * (eTLD+1) from both the page hostname and the cookie domain, then compares
 * them. This correctly handles multi-part TLDs like ".co.uk" or ".com.au"
 * where a naive "last two labels" split would give wrong results.
 *
 * Examples:
 *   cookie ".doubleclick.net"  on "www.example.com"  → third-party ✓
 *   cookie ".example.co.uk"   on "shop.example.co.uk" → first-party ✓
 *   cookie ".parliament.uk"   on "blog.parliament.uk" → first-party ✓
 */
function isThirdPartyCookie(cookieDomain: string, pageUrl: string): boolean {
  try {
    const pageHostname = new URL(pageUrl).hostname;
    const cleanCookieDomain = cookieDomain.replace(/^\./, ""); // strip leading dot

    // getDomain() returns the registered domain (eTLD+1) using the PSL,
    // e.g. "sub.example.co.uk" → "example.co.uk".
    // Returns null for IPs, localhost, or unknown TLDs — treat those as first-party.
    const pageRegistered = getDomain(pageHostname);
    const cookieRegistered = getDomain(cleanCookieDomain);

    if (pageRegistered === null || cookieRegistered === null) {
      return false;
    }

    return pageRegistered !== cookieRegistered;
  }
 catch {
    // If the URL can't be parsed at all, treat the cookie as third-party to be safe.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Queries the browser cookie jar for all cookies accessible to the given URL
 * and returns them as structured {@link CookieInfo} objects.
 *
 * HOW chrome.cookies.getAll WORKS:
 * Passing a `url` filter tells Chrome to return every cookie whose domain and
 * path match that URL — the same set the browser would attach to an HTTP
 * request for that URL. This includes:
 *   • First-party cookies set by the page itself.
 *   • Third-party cookies that were set during previous visits to that page
 *     (e.g. from embedded ad iframes or analytics scripts).
 *   • Cookies set before the extension was installed — the cookie jar is a
 *     persistent browser store, not per-extension storage.
 *
 * IMPORTANT — WHAT IS NOT RETURNED:
 *   • Cookies for OTHER domains that the page has not interacted with.
 *     (Use chrome.cookies.getAll({}) with no filter to get every cookie in
 *     the entire jar, but that requires careful privacy consideration.)
 *   • Cookies set AFTER this call returns. If the user clicks an "Allow
 *     cookies" banner after the popup opens, those new cookies won't appear
 *     until the popup is re-opened (or until onChanged is wired up).
 *
 * SCALE:
 * getAll() returns all matching cookies in one call — there is no pagination.
 * Chrome's cookie store can hold thousands of cookies, and the runtime message
 * channel supports payloads up to 64 MB, so even 500+ cookies per site is
 * handled fine. The only practical limit is popup rendering performance.
 *
 * @param pageUrl - The full URL of the page (e.g. "https://example.com/path").
 *                  Used both to filter cookies via chrome.cookies.getAll and to
 *                  detect third-party cookies.
 */
export async function queryCookiesForUrl(pageUrl: string): Promise<CookieQueryResult> {
  // chrome.cookies.getAll with a `url` filter returns every cookie the browser
  // would send in a request to that URL (same-domain + any third-party cookies
  // that were set while on that page).
  const rawCookies: chrome.cookies.Cookie[] = await chrome.cookies.getAll({ url: pageUrl });

  const cookies: CookieInfo[] = rawCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expirationDate: c.expirationDate ?? null,
    expiresFormatted: formatExpiry(c.expirationDate),
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    isThirdParty: isThirdPartyCookie(c.domain, pageUrl),
  }));

  return {
    cookies,
    queriedAt: new Date().toISOString(),
  };
}
