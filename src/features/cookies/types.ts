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

  /**
   * True when the cookie is a known harmless security/anti-abuse token
   * (e.g. Google AEC, __Secure-YEC). Still third-party, but not a tracker.
   */
  isSecurityCookie: boolean;
}

/**
 * Raw result from queryCookiesForUrl — the cookies and timestamp.
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
   * Used to look up that tab's observed third-party origins.
   */
  tabId: number;
}

/** Response returned by the background for a GET_COOKIES message. */
export interface GetCookiesResponse {
  /** All cookies currently in the jar for this URL. */
  cookies: CookieInfo[];
  /** ISO timestamp of when the query ran. */
  queriedAt: string;
}

/** Alert patterns detected by analyzing POST payloads */
export type AlertPattern = "action_tracking" | "pii_exfiltration";

/** Information about a detected privacy alert */
export interface AlertInfo {
  id: string; // Unique ID (e.g., hash or requestId)
  type: AlertPattern;
  url: string; // the URL that triggered the alert
  domain: string; // The third-party domain
  details: string[]; // Details like what was found ("phone number", "click action")
}

/** Message sent from the popup to the background to fetch triggered alerts. */
export interface GetAlertsMessage {
  type: "GET_ALERTS";
  tabId: number;
}

/** Response returned by the background for a GET_ALERTS message. */
export interface GetAlertsResponse {
  alerts: AlertInfo[];
}
