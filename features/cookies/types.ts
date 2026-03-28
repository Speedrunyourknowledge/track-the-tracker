/**
 * Represents the extracted data for a single browser cookie.
 * Fields mirror the chrome.cookies.Cookie API, with humanized additions.
 */
export interface CookieInfo {
  /** Cookie name */
  name: string;

  /** Cookie value (may be opaque/encoded) */
  value: string;

  /**
   * The domain that set the cookie.
   * A leading dot (e.g. ".example.com") means it applies to all subdomains.
   */
  domain: string;

  /**
   * The URL path the cookie is scoped to (usually "/").
   */
  path: string;

  /**
   * Unix timestamp (seconds) when the cookie expires.
   * null for session cookies that expire when the browser closes.
   */
  expirationDate: number | null;

  /**
   * Human-readable expiry, e.g. "2026-12-31" or "Session".
   */
  expiresFormatted: string;

  /**
   * Whether the cookie carries the Secure flag (HTTPS only).
   */
  secure: boolean;

  /**
   * Whether the cookie is inaccessible to JavaScript (HttpOnly flag).
   */
  httpOnly: boolean;

  /**
   * SameSite policy: "strict", "lax", "no_restriction", or "unspecified".
   */
  sameSite: chrome.cookies.SameSiteStatus;

  /**
   * True when the cookie's domain does NOT match the current page's domain —
   * i.e. it was placed by a third party (tracker, ad network, analytics, etc.).
   */
  isThirdParty: boolean;
}

/**
 * Raw result from queryCookiesForUrl — just the cookies and timestamp,
 * without the snapshot diff fields that the background adds.
 */
export interface CookieQueryResult {
  cookies: CookieInfo[];
  queriedAt: string;
}

/** Message sent from the popup (or any context) to the background. */
export interface GetCookiesMessage {
  type: "GET_COOKIES";
  /** The full URL of the page whose cookies should be fetched. */
  url: string;
  /**
   * The Chrome tab ID of the active tab.
   * Used to look up that tab's page-load snapshot so we can compute a diff
   * and show which cookies are new since the page loaded.
   */
  tabId: number;
}

/** Response returned by the background for a GET_COOKIES message. */
export interface GetCookiesResponse {
  /** All cookies currently in the jar for this URL. */
  cookies: CookieInfo[];
  /**
   * Cookies that did NOT exist when the page first loaded.
   * These are the cookies most likely set by an "Allow cookies" banner click,
   * a login flow, or any other post-load interaction.
   */
  newSinceLoad: CookieInfo[];
  /**
   * Cookies that existed at page load but whose value has changed since.
   * e.g. a session token that was rotated after login.
   */
  changedSinceLoad: CookieInfo[];
  /** ISO timestamp of when the query ran. */
  queriedAt: string;
  /**
   * ISO timestamp of when the page-load snapshot was taken.
   * null if no snapshot exists yet for this tab (e.g. the tab was already
   * open before the extension was installed or last restarted).
   */
  snapshotTakenAt: string | null;
}
