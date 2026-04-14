// Service worker — runs persistently in the background.
//
// WHY THE BACKGROUND?
// chrome.cookies and chrome.webRequest are privileged APIs that Chrome only
// exposes to the background service worker (not to popups or content scripts).
// Every cookie read/write in this extension must go through here.
//
// LIFECYCLE NOTE:
// Manifest V3 service workers can be terminated by Chrome when idle and
// re-spawned on demand. Do not rely on in-memory state surviving between
// activations — use chrome.storage if you need persistence.

import { getDomain } from "tldts";
import { queryCookiesWithThirdParty } from "../features/cookies/cookieQuery";
import {
  recordThirdPartyOrigin,
  clearThirdPartyOrigins,
  isThirdPartyRequest,
} from "../features/cookies/thirdPartyDomains";
import type {
  GetCookiesMessage,
  GetCookiesResponse,
  AlertInfo,
  GetAlertsMessage,
  PostRequestInfo,
  GetPostRequestsMessage,
  ClearPiiBadgeMessage,
  ClearCookieBadgeMessage,
} from "../features/cookies/types";

// ---------------------------------------------------------------------------
// Privacy Alert State
// ---------------------------------------------------------------------------

// Maps tabId to a list of alerts detected on that tab
const tabAlerts = new Map<number, AlertInfo[]>();

// Maps tabId to all third-party POST requests observed (non-auth, non-first-party)
const tabPostRequests = new Map<number, PostRequestInfo[]>();

// Tracks the current badge state per tab so the cookie indicator is only
// shown once per page load ("cookie" | "pii").  Once either badge is set
// further updateBadge calls are ignored, preventing repeated notifications
// as new third-party requests trickle in after the initial page load.
const tabBadgeState = new Map<number, "cookie" | "pii">();

// Temporary storage for POST payloads between onBeforeRequest and onSendHeaders
const pendingPayloads = new Map<string, string>(); // requestId -> payload string

// Maximum top-level keys stored from a JSON payload for display in the popup
const PAYLOAD_PREVIEW_MAX_KEYS = 30;
// Maximum characters stored for non-JSON payloads
const PAYLOAD_PREVIEW_MAX_CHARS = 500;

/**
 * Builds a payload string safe for storage and later display.
 * For JSON objects: parses and re-serializes up to PAYLOAD_PREVIEW_MAX_KEYS
 * top-level keys, so the stored value is always valid JSON regardless of
 * original payload size.
 * For non-JSON: falls back to a raw character slice.
 */
function buildPayloadPreview(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>).slice(0, PAYLOAD_PREVIEW_MAX_KEYS);
      return JSON.stringify(Object.fromEntries(entries));
    }
  } catch { /* not JSON */ }
  return payload.slice(0, PAYLOAD_PREVIEW_MAX_CHARS);
}

function clearTabData(tabId: number): void {
  tabAlerts.delete(tabId);
  tabPostRequests.delete(tabId);
  tabBadgeState.delete(tabId);  // reset so fresh indicator can appear on next page
}

function addAlert(tabId: number, alert: AlertInfo): void {
  const alerts = tabAlerts.get(tabId) || [];
  // Avoid duplicate alerts for the exact same issue
  if (!alerts.some((a) => a.id === alert.id)) {
    alerts.push(alert);
    tabAlerts.set(tabId, alerts);
    if (alert.type === "pii_exfiltration" || alert.type === "location_tracking") {
      setPiiBadge(tabId);
    }
  }
}

function addPostRequest(tabId: number, req: Omit<PostRequestInfo, "count">): void {
  const reqs = tabPostRequests.get(tabId) || [];
  const existing = reqs.find((r) => r.domain === req.domain);
  if (existing) {
    existing.count += 1;
    // Union fields, piiFields, and trackingFields across all requests to this domain.
    for (const f of req.fields) {
      if (!existing.fields.includes(f)) existing.fields.push(f);
    }
    for (const f of req.piiFields) {
      if (!existing.piiFields.includes(f)) existing.piiFields.push(f);
    }
    for (const f of req.trackingFields) {
      if (!existing.trackingFields.includes(f)) existing.trackingFields.push(f);
    }
    // If any occurrence sent a cookie, mark the entry as cookie-linked.
    if (req.hasCookie) existing.hasCookie = true;
  } else {
    reqs.push({ ...req, count: 1 });
    tabPostRequests.set(tabId, reqs);
  }
}

// ---------------------------------------------------------------------------
// Auth request detection
// ---------------------------------------------------------------------------

// OAuth 2.0 / OpenID Connect payload field names (RFC 6749, RFC 7523).
// If a POST body contains any of these, it is almost certainly an auth
// handshake, not a tracking call — regardless of which domain it goes to.
const AUTH_PAYLOAD_FIELDS = [
  "grant_type",    // present in every OAuth 2.0 token request
  "client_secret", // OAuth client credential
  "assertion",     // JWT bearer assertion (RFC 7523)
  "id_token",      // OpenID Connect identity token
  "refresh_token", // OAuth 2.0 refresh token exchange
];

// Match /oauth and /oauth2 path prefixes only. We intentionally exclude
// broader terms like /token or /login because those appear in tracker
// endpoint paths too (e.g. /api/get-token-info, /events/user-login-actions).
// The payload field check below handles those auth flows instead.
const AUTH_PATH_RE = /\/oauth2?(?:\/|$)/i;

// ---------------------------------------------------------------------------
// PII field-name detection tables
// ---------------------------------------------------------------------------

// Generic email-related field names. Unambiguous enough to flag against any
// domain, and catch hashed emails that the regex below cannot detect.
const EMAIL_FIELD_NAMES = [
  "email",
  "user_email",
  "email_address",
  "mail_address",
  "hashed_email",
  "sha256_email",
  "sha256_email_address",
];

// Generic phone-related field names. `phone_number` and `sha256_phone_number`
// are specific enough to be reliable without domain context.
const PHONE_FIELD_NAMES = [
  "phone",
  "phone_number",
  "hashed_phone",
  "sha256_phone_number",
];

// Location-related field names. Limited to unambiguous GPS/geo terms.
// "coordinates" and "coords" are intentionally excluded — they are too
// generic (screen bounding boxes, SVG points, etc.) to reliably indicate
// location tracking.
const LOCATION_FIELD_NAMES = [
  "latitude",
  "longitude",
  "lat",
  "lng",
  "geo",
  "geolocation",
  "gps",
];

// Per-tracker field names for known advertising and analytics platforms.
// Keys are registered domains matched via getDomain(). These catch
// platform-specific hashed fields (e.g. Facebook "em", "ph") that are
// meaningless noise without the domain context.
const TRACKER_FIELD_MAP: Record<string, { label: string; fields: string[] }> = {
  // Facebook CAPI — short field names are Meta-specific abbreviations,
  // too ambiguous to flag generically without the domain context.
  "facebook.com": {
    label: "Facebook",
    fields: ["em", "ph", "fn", "ln", "db", "ge", "external_id"],
  },
  // Google Analytics 4 enhanced conversions — ep.email is a GA4-specific
  // event parameter; sha256_* variants are already in the generic lists.
  "google-analytics.com": {
    label: "Google Analytics",
    fields: ["ep.email"],
  },
  "google.com": {
    label: "Google Analytics",
    fields: ["ep.email"],
  },
  // TikTok Events API — email/phone_number covered generically; external_id is
  // TikTok's persistent user identifier.
  "tiktok.com": {
    label: "TikTok",
    fields: ["external_id"],
  },
  // Snapchat — em/ph are Meta-style abbreviations also used by Snap;
  // madid is the Mobile Ad ID (IDFA/GAID).
  "snap.com": {
    label: "Snapchat",
    fields: ["em", "ph", "madid"],
  },
  // LinkedIn Insight Tag
  "linkedin.com": {
    label: "LinkedIn",
    fields: ["firstName", "lastName"],
  },
  // Pinterest Tag
  "pinterest.com": {
    label: "Pinterest",
    fields: ["em", "ph"],
  },
  // X (Twitter) Conversions API — twclid ties a conversion back to a specific
  // Twitter ad click.
  "twitter.com": {
    label: "X (Twitter)",
    fields: ["twclid"],
  },
  "x.com": {
    label: "X (Twitter)",
    fields: ["twclid"],
  },
  // Reddit Pixel — idfa/aaid are iOS/Android device advertising IDs.
  "redditmedia.com": {
    label: "Reddit",
    fields: ["external_id", "idfa", "aaid"],
  },
};

/**
 * Returns true if `field` appears as a key in the payload, handling both
 * URL-encoded (key=value) and JSON ("key": value) formats.
 */
function hasField(payload: string, field: string): boolean {
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[&?{,\\[\\s])${esc}=|["']${esc}["']\\s*:`, "i").test(payload);
}

/**
 * Extracts unique field names from a payload for display in the popup.
 * For JSON, collects keys from the root object and 2 levels deeper (i.e.
 * root keys, their children's keys, and their grandchildren's keys).
 * For URL-encoded payloads, returns each parameter name.
 * Capped at 20 keys to keep the UI manageable.
 */
function extractFields(payload: string): string[] {
  const keys = new Set<string>();

  // Try JSON
  try {
    const parsed: unknown = JSON.parse(payload);
    function collect(value: unknown, depth: number): void {
      if (depth > 2 || keys.size >= 20) {
        return;
      }
      if (Array.isArray(value)) {
        if (value.length > 0) {
          collect(value[0], depth);
        }
      } 
      else if (typeof value === "object" && value !== null) {
        for (const k of Object.keys(value as Record<string, unknown>)) {
          keys.add(k);
          collect((value as Record<string, unknown>)[k], depth + 1);
        }
      }
    }
    collect(parsed, 0);
    if (keys.size > 0) {
      return [...keys];
    }
  } 
  catch {
    // Not valid JSON — fall through to URL-encoded
  }

  // Try URL-encoded form data
  try {
    const params = new URLSearchParams(payload);
    for (const k of params.keys()) {
      keys.add(k);
      if (keys.size >= 20) {
        break;
      }
    }
  } 
  catch {
    // Ignore
  }

  return [...keys];
}

/**
 * Returns true if the request looks like an authentication handshake.
 * Uses OAuth payload field names and path heuristics rather than a domain
 * allowlist, so it works across all identity providers.
 */
function isAuthRequest(url: string, payload: string): boolean {
  try {
    if (AUTH_PATH_RE.test(new URL(url).pathname)) {
      return true;
    }
  } 
  catch {
    // ignore invalid URLs
  }
  const lower = payload.toLowerCase();
  return AUTH_PAYLOAD_FIELDS.some((field) => lower.includes(field));
}

/**
 * Extracts a short text snippet centered on the first match of pattern in
 * payload, with up to 25 chars of context on each side.
 * Returns an empty string if there is no match.
 */
function extractMatchSnippet(payload: string, pattern: RegExp): string {
  const match = pattern.exec(payload);
  if (!match) return "";
  const start = Math.max(0, match.index - 10);
  const end = Math.min(payload.length, match.index + match[0].length + 55);
  const raw = (start > 0 ? "\u2026" : "") + payload.slice(start, end) + (end < payload.length ? "\u2026" : "");
  // Unescape JSON string escapes that appear when the payload was stringified from formData
  return raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/** Extracts a string from a WebRequestBody */
function getPayloadString(requestBody: chrome.webRequest.WebRequestBody): string {
  if (requestBody.formData) {
    try {
      return JSON.stringify(requestBody.formData);
    }
 catch {
      return "";
    }
  }
  if (requestBody.raw && requestBody.raw.length > 0) {
    const bytes = requestBody.raw[0].bytes;
    if (bytes) {
      try {
        const decoder = new TextDecoder("utf-8");
        return decoder.decode(bytes);
      }
 catch {
        // Ignore decoding errors
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

/**
 * Updates the extension icon badge for a specific tab.
 * A yellow dot appears once when third-party tracking cookies are first
 * detected, alerting the user without repeatedly retriggering as more
 * requests arrive.  Passing count=0 clears the badge (e.g. on navigation).
 */
function updateBadge(tabId: number, count: number): void {
  if (count > 0) {
    // Only show the indicator once per page load — if a badge is already
    // visible (cookie or higher-priority PII) don't overwrite or re-trigger.
    if (!tabBadgeState.has(tabId)) {
      chrome.action.setBadgeBackgroundColor({ color: "#eab308", tabId });
      chrome.action.setBadgeTextColor({ color: "#ffffff", tabId });
      chrome.action.setBadgeText({ text: "!", tabId });
      tabBadgeState.set(tabId, "cookie");
    }
  }
  else {
    chrome.action.setBadgeText({ text: "", tabId });
  }
}

/**
 * Switches the badge to orange with a "!" to signal an active PII alert.
 * Takes priority over the yellow cookie-dot badge so the user notices
 * something more serious than a tracking cookie was detected.
 * Resets naturally on the next navigation when updateBadge() runs again.
 */
function setPiiBadge(tabId: number): void {
  chrome.action.setBadgeBackgroundColor({ color: "#f97316", tabId });
  chrome.action.setBadgeTextColor({ color: "#ffffff", tabId });
  chrome.action.setBadgeText({ text: "!", tabId });
  // Mark as pii so subsequent cookie-badge calls don't overwrite this alert.
  tabBadgeState.set(tabId, "pii");
}

// Per-tab debounce timers so the badge updates after the burst of webRequest
// events following page load settles, rather than only at tabs.onUpdated complete.
const badgeUpdateTimers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleBadgeUpdate(tabId: number): void {
  const existing = badgeUpdateTimers.get(tabId);
  if (existing !== undefined) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    badgeUpdateTimers.delete(tabId);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab.url) {
        return;
      }
      queryCookiesWithThirdParty(tab.url, tabId)
        .then((result) => {
          const count = result.cookies.filter((c) => c.isThirdParty && !c.isSecurityCookie).length;
          updateBadge(tabId, count);
        })
        .catch((err) => console.error("[Track the Tracker] Deferred badge update failed:", err));
    });
  }, 1000);

  badgeUpdateTimers.set(tabId, timer);
}

export default defineBackground(() => {
  console.log("Track the Tracker background started.");

  // -------------------------------------------------------------------------
  // THIRD-PARTY ORIGIN TRACKING — observe outgoing requests via webRequest.
  //
  // For each completed request, we check whether its domain differs from the
  // page that initiated it (the initiator). If so, it's a third-party request
  // and we record the origin so the cookie query layer can later fetch cookies
  // stored under that domain.
  //
  // WHY onCompleted?
  // We don't need to block or modify requests — we only need to know which
  // third-party domains were contacted so we can look up their cookies.
  // onCompleted fires after the response is received, which is also when any
  // Set-Cookie headers from that response have been applied to the cookie jar.
  //
  // tabId < 0 means the request came from the service worker itself, not a tab.
  // initiator is undefined for top-level navigations — skip those too.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // PAYLOAD INTERCEPTION — Detect PII and Tracking in POST requests.
  // -------------------------------------------------------------------------
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.method === "POST" && details.requestBody) {
        const payload = getPayloadString(details.requestBody);
        if (payload) {
          pendingPayloads.set(details.requestId, payload);
        }
      }
    },
    { urls: ["<all_urls>"] },
    ["requestBody"]
  );

  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      const payload = pendingPayloads.get(details.requestId);
      if (!payload) {
        return;
      }

      // Only analyze third-party requests — first-party POST requests (e.g.
      // submitting a form to your own site) are not a privacy concern.
      if (!details.initiator || !isThirdPartyRequest(details.url, details.initiator)) {
        return;
      }

      // Skip binary requests (gRPC, protobuf, raw byte streams). These are
      // typically internal service calls, not user-data tracking payloads,
      // and their encoded bodies produce meaningless garbled output.
      const contentType = details.requestHeaders
        ?.find((h) => h.name.toLowerCase() === "content-type")
        ?.value ?? "";
      if (/grpc|protobuf|octet-stream/i.test(contentType)) {
        pendingPayloads.delete(details.requestId);
        return;
      }

      // Skip authentication handshakes (OAuth token exchanges, OpenID Connect,
      // etc.) so legitimate "Sign in with Google"-style flows are not flagged.
      if (isAuthRequest(details.url, payload)) {
        return;
      }

      const domain = new URL(details.url).hostname;
      const payloadPreview = buildPayloadPreview(payload);
      const fields = extractFields(payload);

      // Mark which extracted fields match a known PII pattern so the popup
      // can highlight them without duplicating the detection logic.
      // LOCATION_FIELD_NAMES included here only so location fields are
      // highlighted in the POST requests list; location alerts are separate.
      const allPiiFieldNames = [...EMAIL_FIELD_NAMES, ...PHONE_FIELD_NAMES, ...LOCATION_FIELD_NAMES];
      const piiFields = fields.filter((f) =>
        allPiiFieldNames.some((p) => p.toLowerCase() === f.toLowerCase())
      );

      // Pre-compute tracking fields so they can be highlighted in the requests list.
      const TRACKING_RES = [/click/i, /scroll/i, /video/i, /coord/i, /page|referrer/i];
      const trackingFields = fields.filter(f => TRACKING_RES.some(re => re.test(f)));

      // True when the request includes a Cookie header — the third party can
      // tie this POST to a persistent identity stored on the user's browser.
      const hasCookie = details.requestHeaders?.some(
        (h) => h.name.toLowerCase() === "cookie"
      ) ?? false;

      // Record every third-party non-auth POST so the user can inspect them.
      addPostRequest(details.tabId, {
        id: details.requestId,
        url: details.url,
        domain,
        payloadPreview,
        fields,
        piiFields,
        trackingFields,
        hasCookie,
      });

      // --- PII check ---
      const piiDetails: string[] = [];
      const flaggedFields: string[] = [];

      // Plaintext email via regex (no specific field name to highlight).
      // Requires at least 3 chars before @ and a domain with at least one dot
      // and a 2+ char TLD, to avoid false positives from binary payloads that
      // happen to contain @ symbols.
      if (/[a-zA-Z0-9._%+-]{3,}@[a-zA-Z0-9-]{2,}\.[a-zA-Z]{2,}/.test(payload)) {
        piiDetails.push("Email (plaintext)");
      }

      // Email field names — catches hashed emails the regex misses
      const emailFields = EMAIL_FIELD_NAMES.filter((f) => hasField(payload, f));
      if (emailFields.length > 0) {
        piiDetails.push(`Email field: ${emailFields.join(", ")}`);
        flaggedFields.push(...emailFields);
      }

      // Phone field names
      const phoneFields = PHONE_FIELD_NAMES.filter((f) => hasField(payload, f));
      if (phoneFields.length > 0) {
        piiDetails.push(`Phone field: ${phoneFields.join(", ")}`);
        flaggedFields.push(...phoneFields);
      }

      // Tracker-specific field names (e.g. Facebook "em", Google "sha256_email_address")
      const registeredDomain = getDomain(domain) ?? "";
      const trackerEntry = TRACKER_FIELD_MAP[registeredDomain];
      if (trackerEntry) {
        const matched = trackerEntry.fields.filter((f) => hasField(payload, f));
        if (matched.length > 0) {
          piiDetails.push(`${trackerEntry.label} user data: ${matched.join(", ")}`);
          flaggedFields.push(...matched);
        }
      }

      // --- Location tracking alert (separate from PII) ---
      const locationFields = LOCATION_FIELD_NAMES.filter((f) => hasField(payload, f));
      if (locationFields.length > 0) {
        const locationFlaggedFields = [...locationFields];
        const locationSnippets: string[] = [];
        for (const field of locationFlaggedFields) {
          const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const fieldPattern = new RegExp(`(?:["']${esc}["']\\s*:|[?&]${esc}=)`, "i");
          const fieldSnippet = extractMatchSnippet(payload, fieldPattern);
          if (fieldSnippet) {
            locationSnippets.push(fieldSnippet);
            break;
          }
        }
        addAlert(details.tabId, {
          id: details.requestId + "-location",
          type: "location_tracking",
          url: details.url,
          domain,
          details: [`Location fields: ${locationFields.join(", ")}`],
          flaggedFields: locationFlaggedFields,
          matchSnippets: locationSnippets,
          payload: payloadPreview,
        });
      }

      if (piiDetails.length > 0) {
        const EMAIL_RE = /[a-zA-Z0-9._%+-]{3,}@[a-zA-Z0-9-]{2,}\.[a-zA-Z]{2,}/;
        const piiSnippets: string[] = [];
        const emailSnippet = extractMatchSnippet(payload, EMAIL_RE);
        if (emailSnippet) piiSnippets.push(emailSnippet);

        // For field-name matches, extract a snippet showing the field and its
        // value so the user can see what triggered the alert (e.g. email).
        for (const field of flaggedFields) {
          const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const fieldPattern = new RegExp(`(?:["']${esc}["']\\s*:|[?&]${esc}=)`, "i");
          const fieldSnippet = extractMatchSnippet(payload, fieldPattern);
          if (fieldSnippet) {
            piiSnippets.push(fieldSnippet);
            break;
          }
        }

        addAlert(details.tabId, {
          id: details.requestId + "-pii",
          type: "pii_exfiltration",
          url: details.url,
          domain,
          details: piiDetails,
          flaggedFields,
          matchSnippets: piiSnippets,
          payload: payloadPreview,
        });
      }

      // --- Action tracking check ---
      // No cookie requirement — a third party receiving behavioural field names
      // (page URL, click coords, scroll depth, etc.) is tracking the user
      // regardless of whether a cookie header is present. The cookie flag is
      // still surfaced as metadata in the POST requests list.
      {
        const trackingDetails: string[] = [];
        const trackingFlaggedFields: string[] = [];
        const trackingSnippets: string[] = [];

        // Simple substring matches against field names — any field name
        // containing these keywords sent to a third party is considered tracking.
        const CLICK_RE = /click/i;
        const SCROLL_RE = /scroll/i;
        const VIDEO_RE = /video/i;
        const COORDS_RE = /coord/i;
        const PAGE_RE = /page|referrer/i;

        // Only fire when each keyword appears in a field *name*.
        // Matching against values produces too many false positives.
        const clickMatches = fields.filter(f => CLICK_RE.test(f));
        if (clickMatches.length > 0) {
          trackingDetails.push("Clicks");
          trackingFlaggedFields.push(...clickMatches);
          const snippet = extractMatchSnippet(payload, CLICK_RE);
          if (snippet) trackingSnippets.push(snippet);
        }
        const scrollMatches = fields.filter(f => SCROLL_RE.test(f));
        if (scrollMatches.length > 0) {
          trackingDetails.push("Scroll behavior");
          trackingFlaggedFields.push(...scrollMatches);
          const snippet = extractMatchSnippet(payload, SCROLL_RE);
          if (snippet) trackingSnippets.push(snippet);
        }
        const videoMatches = fields.filter(f => VIDEO_RE.test(f));
        if (videoMatches.length > 0) {
          trackingDetails.push("Video playback");
          trackingFlaggedFields.push(...videoMatches);
          const snippet = extractMatchSnippet(payload, VIDEO_RE);
          if (snippet) trackingSnippets.push(snippet);
        }
        const coordMatches = fields.filter(f => COORDS_RE.test(f));
        if (coordMatches.length > 0) {
          trackingDetails.push("Screen coordinates");
          trackingFlaggedFields.push(...coordMatches);
          const snippet = extractMatchSnippet(payload, COORDS_RE);
          if (snippet) trackingSnippets.push(snippet);
        }
        const pageMatches = fields.filter(f => PAGE_RE.test(f));
        if (pageMatches.length > 0) {
          trackingDetails.push("Page visits");
          trackingFlaggedFields.push(...pageMatches);
          const snippet = extractMatchSnippet(payload, PAGE_RE);
          if (snippet) trackingSnippets.push(snippet);
        }
        if (trackingDetails.length > 0) {
          addAlert(details.tabId, {
            id: details.requestId + "-tracking",
            type: "action_tracking",
            url: details.url,
            domain,
            details: trackingDetails,
            flaggedFields: [...new Set(trackingFlaggedFields)],
            matchSnippets: trackingSnippets,
            payload: payloadPreview,
          });
        }
      }
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders", "extraHeaders"]
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => pendingPayloads.delete(details.requestId),
    { urls: ["<all_urls>"] }
  );

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      pendingPayloads.delete(details.requestId);

      if (details.tabId < 0 || !details.initiator) {
        return;
      }

      try {
        if (isThirdPartyRequest(details.url, details.initiator)) {
          const requestOrigin = new URL(details.url).origin;
          recordThirdPartyOrigin(details.tabId, requestOrigin)
            .then((isNew) => {
              if (isNew) {
                scheduleBadgeUpdate(details.tabId);
              }
            })
            .catch((err) =>
              console.error("[Track the Tracker] Failed to record third-party origin:", err),
            );
        }
      } 
      catch {
        // Ignore unparseable URLs
      }
    },
    { urls: ["<all_urls>"] },
  );

  // -------------------------------------------------------------------------
  // TAB NAVIGATION — update cookie data every time a tab finishes loading.
  //
  // On navigation START (status: "loading") we clear the previous page's
  // third-party origin list so stale domains don't bleed into the new page.
  //
  // On navigation COMPLETE (status: "complete") we query all cookies —
  // first-party and any third-party origins recorded during this page load —
  // and update the badge with the current third-party cookie count.
  // -------------------------------------------------------------------------
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab.url) {
      return;
    }
    if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
      return;
    }

    if (changeInfo.status === "loading") {
      clearTabData(tabId);
      clearThirdPartyOrigins(tabId).catch((err) =>
        console.error("[Track the Tracker] Failed to clear third-party origins:", err),
      );
      return;
    }

    if (changeInfo.status !== "complete") {
      return;
    }

    queryCookiesWithThirdParty(tab.url, tabId)
      .then((result) => {
        const thirdPartyCount = result.cookies.filter((c) => c.isThirdParty && !c.isSecurityCookie).length;
        updateBadge(tabId, thirdPartyCount);
      })
      .catch((err) => console.error("[Track the Tracker] Cookie query failed:", err));
  });

  // -------------------------------------------------------------------------
  // CLEANUP — remove storage entries when a tab is closed.
  // -------------------------------------------------------------------------
  chrome.tabs.onRemoved.addListener((tabId) => {
      clearTabData(tabId);
    clearThirdPartyOrigins(tabId).catch((err) =>
      console.error("[Track the Tracker] Third-party origin cleanup failed:", err),
    );
    updateBadge(tabId, 0);
  });

  // -------------------------------------------------------------------------
  // Message handler: GET_COOKIES
  //
  // The popup sends a GetCookiesMessage with the active tab's URL and tabId.
  // We fetch the current cookies (first-party + observed third-party origins)
  // and return them to the popup.
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender,
      sendResponse: (response: unknown) => void,
    ) => {
      const msg = message as { type?: string };
      if (msg.type === "GET_ALERTS") {
        const alertsMsg = message as GetAlertsMessage;
        const alerts = tabAlerts.get(alertsMsg.tabId) || [];
        sendResponse({ alerts });
        return false;
      }

      if (msg.type === "CLEAR_COOKIE_BADGE") {
        const clearMsg = message as ClearCookieBadgeMessage;
        const state = tabBadgeState.get(clearMsg.tabId);
        if (state === "cookie") {
          chrome.action.setBadgeText({ text: "", tabId: clearMsg.tabId });
          // Keep state as "cookie" so updateBadge won't re-show the dot
          // until the next navigation resets it via clearTabData.
        }
        sendResponse({});
        return false;
      }

      if (msg.type === "CLEAR_PII_BADGE") {
        const clearMsg = message as ClearPiiBadgeMessage;
        const state = tabBadgeState.get(clearMsg.tabId);
        if (state === "pii") {
          chrome.action.setBadgeText({ text: "", tabId: clearMsg.tabId });
          // Keep state as "pii" so neither the cookie dot nor the PII badge
          // can reappear for this page load after the user has dismissed it.
        }
        sendResponse({});
        return false;
      }

      if (msg.type === "GET_POST_REQUESTS") {
        const postMsg = message as GetPostRequestsMessage;
        const requests = tabPostRequests.get(postMsg.tabId) || [];
        sendResponse({ requests, retrievedAt: new Date().toISOString() });
        return false;
      }

      if (msg.type !== "GET_COOKIES") {
        return false;
      }

      const cookieMessage = message as GetCookiesMessage;
      queryCookiesWithThirdParty(cookieMessage.url, cookieMessage.tabId)
        .then((result) => {
          const response: GetCookiesResponse = {
            cookies: result.cookies,
            queriedAt: result.queriedAt,
          };
          sendResponse(response);
        })
        .catch((err) => {
          console.error("[Track the Tracker] Cookie query failed:", err);
          sendResponse({ cookies: [], queriedAt: new Date().toISOString() });
        });

      return true; // keep message channel open for async response
    },
  );
});
