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

import { queryCookiesWithThirdParty } from "../features/cookies/cookieQuery";
import {
  recordThirdPartyOrigin,
  clearThirdPartyOrigins,
  isThirdPartyRequest,
} from "../features/cookies/thirdPartyDomains";
import type { GetCookiesMessage, GetCookiesResponse } from "../features/cookies/types";

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

/**
 * Updates the extension icon badge for a specific tab.
 * A red badge with the third-party cookie count appears on the toolbar icon,
 * alerting users without requiring them to open the popup.
 * Passing count=0 clears the badge entirely.
 */
function updateBadge(tabId: number, count: number): void {
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444", tabId });
    chrome.action.setBadgeTextColor({ color: "#ffffff", tabId });
    chrome.action.setBadgeText({ text: String(count), tabId });
  } 
  else {
    chrome.action.setBadgeText({ text: "", tabId });
  }
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
  chrome.webRequest.onCompleted.addListener(
    (details) => {
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
      message: GetCookiesMessage,
      _sender,
      sendResponse: (response: GetCookiesResponse) => void,
    ) => {
      if (message.type !== "GET_COOKIES") {
        return false;
      }

      queryCookiesWithThirdParty(message.url, message.tabId)
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
