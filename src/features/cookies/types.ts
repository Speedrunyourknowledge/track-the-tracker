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
export type AlertPattern = "action_tracking" | "pii_exfiltration" | "location_tracking";

/** Information about a detected privacy alert */
export interface AlertInfo {
  id: string; // Unique ID (e.g., hash or requestId)
  type: AlertPattern;
  url: string; // the URL that triggered the alert
  domain: string; // The third-party domain
  labels: string[]; // Short category labels for what was found (e.g. "Email", "Phone", "Clicks")
  /** Verbatim text snippets extracted around each match location, so the trigger is always visible */
  matchSnippets: string[];
  /** First 500 characters of the decoded request body, for manual review */
  payload: string;
}

/** Message sent from the popup to the background to fetch triggered alerts. */
export interface GetAlertsMessage {
  type: "GET_ALERTS";
  tabId: number;
}

/** Response returned by the background for a GET_ALERTS message. */
export interface GetAlertsResponse {
  alerts: AlertInfo[];
  /** True when the user has already opened the Requests tab for this page load. */
  alertsViewed: boolean;
}

/**
 * A third-party POST request observed during this page load that was not
 * filtered out as an authentication request.
 */
export interface PostRequestInfo {
  id: string;
  url: string;
  domain: string;
  /** First 500 characters of the decoded request body */
  payloadPreview: string;
  /** Unique field names extracted from the payload (JSON keys or URL-encoded param names) */
  fields: string[];
  /** Subset of fields that matched a known PII pattern (email, phone, location) */
  piiFields: string[];
  /** Subset of fields that matched an action tracking pattern (page, click, scroll, etc.) */
  actionFields: string[];
  /** True when the request included a Cookie header — the third party can link this POST to a persistent identity */
  hasCookie: boolean;
  /** How many times this domain+fields combination was observed during this page load */
  count: number;
}

/** Message sent from the popup to the background to fetch observed POST requests. */
export interface GetPostRequestsMessage {
  type: "GET_POST_REQUESTS";
  tabId: number;
}

/** Sent when the user opens the Requests tab — tells the background to dismiss the PII badge. */
export interface ClearPiiBadgeMessage {
  type: "CLEAR_PII_BADGE";
  tabId: number;
}

/** Sent when the user views the Cookies tab — tells the background to dismiss the cookie dot badge. */
export interface ClearCookieBadgeMessage {
  type: "CLEAR_COOKIE_BADGE";
  tabId: number;
}

/** Response returned by the background for a GET_POST_REQUESTS message. */
export interface GetPostRequestsResponse {
  requests: PostRequestInfo[];
  retrievedAt: string;
}
