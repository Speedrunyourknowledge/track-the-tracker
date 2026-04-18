/**
 * Service worker — runs persistently in the background.
 *
 * chrome.cookies and chrome.webRequest are privileged APIs that Chrome only
 * exposes to the background service worker (not to popups or content scripts).
 * Every cookie read/write in this extension must go through here.
 *
 * Manifest V3 service workers can be terminated by Chrome when idle and
 * re-spawned on demand. Do not rely on in-memory state surviving between
 * activations — use chrome.storage if you need persistence
 */

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
// as new third-party requests trickle in after the initial page load
const tabBadgeState = new Map<number, "cookie" | "pii">();

// Tracks which tabs have had their Requests tab opened at least once during
// this page load, so the orange dot is not re-shown when the popup reopens
const tabAlertsViewed = new Set<number>();

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
 * For non-JSON: falls back to a raw character slice
 */
function buildPayloadPreview(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>).slice(0, PAYLOAD_PREVIEW_MAX_KEYS);
      return JSON.stringify(Object.fromEntries(entries));
    }
  }
  catch { /* not JSON */ }
  return payload.slice(0, PAYLOAD_PREVIEW_MAX_CHARS);
}

function clearTabData(tabId: number): void {
  tabAlerts.delete(tabId);
  tabPostRequests.delete(tabId);
  tabBadgeState.delete(tabId);  // reset so fresh indicator can appear on next page
  tabAlertsViewed.delete(tabId);
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
    // Union fields, piiFields, and actionFields across all requests to this domain.
    for (const f of req.fields) {
      if (!existing.fields.includes(f)) {
        existing.fields.push(f);
      }
    }
    for (const f of req.piiFields) {
      if (!existing.piiFields.includes(f)) {
        existing.piiFields.push(f);
      }
    }
    for (const f of req.actionFields) {
      if (!existing.actionFields.includes(f)) {
        existing.actionFields.push(f);
      }
    }
  }
  else {
    reqs.push({ ...req, count: 1 });
    tabPostRequests.set(tabId, reqs);
  }
}

// ---------------------------------------------------------------------------
// Auth request detection
// ---------------------------------------------------------------------------

// OAuth 2.0 / OpenID Connect payload fields (RFC 6749, RFC 7523) and SAML fields.
// If a POST body contains any of these, it is almost certainly an auth
// handshake, not a tracking call — regardless of which domain it goes to
const AUTH_PAYLOAD_FIELDS = [
  "grant_type",    // present in every OAuth 2.0 token request
  "client_secret", // OAuth client credential
  "assertion",     // JWT bearer assertion (RFC 7523)
  "id_token",      // OpenID Connect identity token
  "refresh_token", // OAuth 2.0 refresh token exchange
  "code_verifier", // PKCE — unambiguously part of an OAuth code exchange
  "SAMLResponse",  // SAML 2.0 SP-initiated SSO response
  "SAMLRequest",   // SAML 2.0 IdP-initiated SSO request
];

// Matches /oauth, /oauth2, /saml, and /connect/token path segments anywhere in
// the pathname (e.g. /api/oauth2/token also matches). Broader terms like /token
// or /login are intentionally excluded — they appear in tracker endpoint paths
// too (e.g. /api/get-token-info). The payload field check handles those flows
const AUTH_PATH_RE = /\/oauth2?(?:\/|$)|\/saml(?:\/|$)|\/connect\/token(?:\/|$)/i;

// Matches page-visit fields while excluding generic fields like "pageFormat"
const PAGE_RE = /^page(?:s|url|_url|path|_path|title|_title|view|_view|name|_name|ref|_ref|referrer|_referrer|hit|_hit)?$|^referrer(?:url|_url)?$/i;

// ---------------------------------------------------------------------------
// PII field name detection
// ---------------------------------------------------------------------------

// Email-related fields
const EMAIL_FIELD_NAMES = [
  "email",
  "user_email",
  "email_address",
  "mail_address",
  "hashed_email",
  "sha256_email",
  "sha256_email_address",
];

// Phone-related fields
const PHONE_FIELD_NAMES = [
  "phone",
  "phone_number",
  "hashed_phone",
  "sha256_phone_number",
];

// Location-related fields
const LOCATION_FIELD_NAMES = [
  "latitude",
  "longitude",
  "lat",
  "lng",
  "geo",
  "geolocation",
  "gps",
  "country",
  "city",
  "state",
  "zip",
  "zip_code",
  "postal_code",
  "region",
  "province",
];

// Human-readable display names for field names that are abbreviated or ambiguous.
// This controls how field names appear in the UI
const FIELD_DISPLAY_NAMES: Record<string, string> = {
  lat: "lat (latitude)",
  lng: "lng (longitude)",
  geo: "geo (geolocation)",
  gps: "gps (location)",
  zip: "zip (postal code)",
  zip_code: "zip (postal code)",
};

// Per-tracker field names for known advertising and analytics domains.
// This catches domain-specific hashed fields
const TRACKER_FIELD_MAP: Record<string, { label: string; fields: string[] }> = {
  // Facebook CAPI — short fields are Meta-specific abbreviations,
  // too ambiguous to flag generically without the domain context
  "facebook.com": {
    label: "Facebook",
    fields: ["em", "ph", "fn", "ln", "db", "ge", "external_id"],
  },
  // Google Analytics 4 enhanced conversions — ep.email is a GA4-specific
  // event parameter; sha256_* variants are already in the generic lists
  "google-analytics.com": {
    label: "Google Analytics",
    fields: ["ep.email"],
  },
  "google.com": {
    label: "Google Analytics",
    fields: ["ep.email"],
  },
  // TikTok Events API — email/phone_number covered generically; external_id is
  // TikTok's persistent user identifier
  "tiktok.com": {
    label: "TikTok",
    fields: ["external_id"],
  },
  // Snapchat — em/ph are Meta-style abbreviations also used by Snap;
  // madid is the Mobile Ad ID (IDFA/GAID)
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
  // Twitter ad click
  "twitter.com": {
    label: "X (Twitter)",
    fields: ["twclid"],
  },
  "x.com": {
    label: "X (Twitter)",
    fields: ["twclid"],
  },
  // Reddit Pixel — idfa/aaid are iOS/Android device advertising IDs
  "redditmedia.com": {
    label: "Reddit",
    fields: ["external_id", "idfa", "aaid"],
  },
};

/**
 * Escapes special characters in a field and makes each underscore
 * optional, so the pattern matches with or without word separators.
 * Use this with the `i` flag for case-insensitive matching.
 * Example: "user_email" matches "user_email", "useremail", "user-email"
 */
function flexibleField(name: string): string {
  return name
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/_/g, "_?");
}

/**
 * Builds a regex that matches `field` as a key in either URL-encoded
 * (key=value) or JSON ("key": value) format
 */
function fieldPattern(field: string): RegExp {
  const flex = flexibleField(field);
  return new RegExp(`(?:^|[&?{,\\[\\s])${flex}=|["']${flex}["']\\s*:`, "i");
}

/**
 * Returns true if `field` appears as a key in the payload, handling both
 * URL-encoded (key=value) and JSON ("key": value) formats
 */
function hasField(payload: string, field: string): boolean {
  return fieldPattern(field).test(payload);
}

/**
 * Extracts unique fields from a payload for display in the popup.
 * For JSON, collects keys from the root object and 2 levels deeper (i.e.
 * root keys, their children's keys, and their grandchildren's keys).
 * For URL-encoded payloads, returns each parameter name.
 * Capped at 20 keys to keep the UI manageable
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
 * Uses OAuth payload fields and path heuristics rather than a domain
 * allowlist, so it works across all identity providers
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
  return AUTH_PAYLOAD_FIELDS.some((field) => lower.includes(field.toLowerCase()));
}

/**
 * Extracts a short text snippet centered on the first match of pattern in
 * payload, with up to 25 chars of context on each side.
 * Returns an empty string if there is no match
 */
function extractMatchSnippet(payload: string, pattern: RegExp): string {
  const match = pattern.exec(payload);
  if (!match) {
    return "";
  }
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
 * requests arrive.  Passing count=0 clears the badge (e.g. on navigation)
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
 * Resets naturally on the next navigation when updateBadge() runs again
 */
function setPiiBadge(tabId: number): void {
  chrome.action.setBadgeBackgroundColor({ color: "#f97316", tabId });
  chrome.action.setBadgeTextColor({ color: "#ffffff", tabId });
  chrome.action.setBadgeText({ text: "!", tabId });
  // Mark as pii so subsequent cookie-badge calls don't overwrite this alert.
  tabBadgeState.set(tabId, "pii");
}

// Per-tab debounce timers so the badge updates after the burst of webRequest
// events following page load settles, rather than only at tabs.onUpdated complete
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
  // THIRD-PARTY ORIGIN TRACKING — observe outgoing requests via webRequest
  //
  // For each completed request, we check whether its domain differs from the
  // page that initiated it (the initiator). If so, it's a third-party request
  // and we record the origin so the cookie query layer can later fetch cookies
  // stored under that domain
  // -------------------------------------------------------------------------
  // PAYLOAD INTERCEPTION — Detect PII and Tracking in POST requests
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
      // submitting a form to your own site) are not a privacy concern
      if (!details.initiator || !isThirdPartyRequest(details.url, details.initiator)) {
        return;
      }

      // Skip binary requests (gRPC, protobuf, raw byte streams). These are
      // typically internal service calls and they are not useful for analysis
      const contentType = details.requestHeaders
        ?.find((h) => h.name.toLowerCase() === "content-type")
        ?.value ?? "";
      if (/grpc|protobuf|octet-stream/i.test(contentType)) {
        pendingPayloads.delete(details.requestId);
        return;
      }

      // Skip authentication handshakes (e.g., OAuth tokens) so
      // legitimate "Sign in with Google"-style flows are not flagged
      if (isAuthRequest(details.url, payload)) {
        return;
      }

      const domain = new URL(details.url).hostname;
      const payloadPreview = buildPayloadPreview(payload);
      const fields = extractFields(payload);

      // Mark fields that match a known PII pattern so the request can be 
      // highlighted in the POST requests list
      const allPiiFieldNames = [...EMAIL_FIELD_NAMES, ...PHONE_FIELD_NAMES, ...LOCATION_FIELD_NAMES];
      const piiFields = fields.filter((f) =>
        allPiiFieldNames.some((p) => p.toLowerCase() === f.toLowerCase())
      );

      // Pre-compute tracking fields so they can be highlighted in the POST requests list
      const ACTION_CATEGORIES = [
        { re: /click/i, label: "clicks" },
        { re: /scroll/i, label: "scroll behavior" },
        { re: /video/i, label: "video playback" },
        { re: /coord/i, label: "screen coordinates" },
        { re: PAGE_RE, label: "page visits" },
      ];
      const actionFields = fields.filter(f => ACTION_CATEGORIES.some(({ re }) => re.test(f)));

      // Record every third-party non-auth POST so the user can inspect them
      addPostRequest(details.tabId, {
        id: details.requestId,
        url: details.url,
        domain,
        payloadPreview,
        fields,
        piiFields,
        actionFields,
      });

      // --- PII check ---
      const piiLabels: string[] = [];
      const EMAIL_RE = /[a-zA-Z0-9._%+-]{3,}@[a-zA-Z0-9-]{2,}\.[a-zA-Z]{2,}/;

      // Email fields
      const emailFields = EMAIL_FIELD_NAMES.filter((f) => hasField(payload, f));
      if (emailFields.length > 0) {
        piiLabels.push("email");
      }
      // Fall back to regex matching to detect plaintext email addresses
      else if (EMAIL_RE.test(payload)) {
        piiLabels.push("email (plaintext)");
      }

      // Phone fields
      const phoneFields = PHONE_FIELD_NAMES.filter((f) => hasField(payload, f));
      if (phoneFields.length > 0) {
        piiLabels.push("phone");
      }

      // Tracker-specific fields (e.g. Facebook "em")
      const registeredDomain = getDomain(domain) ?? "";
      const trackerEntry = TRACKER_FIELD_MAP[registeredDomain];
      let piiTrackerFields: string[] = [];
      if (trackerEntry) {
        piiTrackerFields = trackerEntry.fields.filter((f) => hasField(payload, f));
        if (piiTrackerFields.length > 0) {
          piiLabels.push(trackerEntry.label);
        }
      }

      // --- Location tracking alert (separate from PII) ---
      const locationFlaggedFields = LOCATION_FIELD_NAMES.filter((f) => hasField(payload, f));
      if (locationFlaggedFields.length > 0) {
        // One snippet is enough — location fields are usually grouped together
        // (e.g., country/state/zip) so multiple snippets would overlap.
        const locationSnippets: string[] = [];
        for (const field of locationFlaggedFields) {
          const fieldSnippet = extractMatchSnippet(payload, fieldPattern(field));
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
          labels: [FIELD_DISPLAY_NAMES[locationFlaggedFields[0]] ?? locationFlaggedFields[0]],
          matchSnippets: locationSnippets,
          payload: payloadPreview,
        });
      }

      // --- PII tracking alert ---
      if (piiLabels.length > 0) {
        const piiSnippets: string[] = [];

        // Snippet for plaintext email address
        const emailSnippet = extractMatchSnippet(payload, EMAIL_RE);
        if (emailSnippet) {
          piiSnippets.push(emailSnippet);
        }

        // One snippet per PII category — multiple fields of the same type
        // (e.g. email + user_email) would produce redundant snippets.
        for (const fieldGroup of [emailFields, phoneFields, piiTrackerFields]) {
          for (const field of fieldGroup) {
            const fieldSnippet = extractMatchSnippet(payload, fieldPattern(field));
            if (fieldSnippet) {
              piiSnippets.push(fieldSnippet);
              break;
            }
          }
        }

        addAlert(details.tabId, {
          id: details.requestId + "-pii",
          type: "pii_exfiltration",
          url: details.url,
          domain,
          labels: piiLabels,
          matchSnippets: piiSnippets,
          payload: payloadPreview,
        });
      }

      // --- Action tracking alert ---
      {
        const actionLabels: string[] = [];
        const actionSnippets: string[] = [];

        // Only fire when the keyword appears in a field name.
        // Matching against values produces many false positives.
        for (const { re, label } of ACTION_CATEGORIES) {
          const matches = fields.filter(f => re.test(f));
          if (matches.length > 0) {
            actionLabels.push(label);
            // One snippet per action category
            for (const matchedField of matches) {
              const snippet = extractMatchSnippet(payload, fieldPattern(matchedField));
              if (snippet) {
                actionSnippets.push(snippet);
                break;
              }
            }
          }
        }

        if (actionLabels.length > 0) {
          addAlert(details.tabId, {
            id: details.requestId + "-action",
            type: "action_tracking",
            url: details.url,
            domain,
            labels: actionLabels,
            matchSnippets: actionSnippets,
            payload: payloadPreview,
          });
        }
      }
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders"]
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
        const alertsViewed = tabAlertsViewed.has(alertsMsg.tabId);
        sendResponse({ alerts, alertsViewed });
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
        // Mark alerts as viewed so the orange dot is not re-shown when the
        // popup is closed and reopened.
        tabAlertsViewed.add(clearMsg.tabId);
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
