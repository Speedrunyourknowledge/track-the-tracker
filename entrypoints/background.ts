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

import { queryCookiesForUrl } from "../features/cookies/cookieQuery";
import { storeSnapshot, diffWithSnapshot, clearSnapshot } from "../features/cookies/cookieSnapshot";
import type { GetCookiesMessage, GetCookiesResponse } from "../features/cookies/types";

export default defineBackground(() => {
  console.log("Track the Tracker background started.");

  // TODO: listen for web requests to identify third-party origins
  // chrome.webRequest.onCompleted.addListener(...)

  // -------------------------------------------------------------------------
  // SNAPSHOT — take a cookie baseline every time a tab finishes loading.
  //
  // This is the foundation of the "new since page load" diff feature. When the
  // user later opens the popup, we compare current cookies against this snapshot
  // to highlight exactly what changed — e.g. what an "Allow cookies" banner set.
  //
  // Why tabs.onUpdated and not cookies.onChanged?
  //   - cookies.onChanged fires for every single cookie write but does NOT tell
  //     us which tab triggered it. Associating cookie changes to tabs is complex.
  //   - tabs.onUpdated fires once per navigation and gives us a clean "before"
  //     baseline. The "after" is computed on-demand when the popup opens.
  //
  // We skip chrome:// and extension pages — cookies.getAll() would fail for those.
  // -------------------------------------------------------------------------
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") {
      return;
    } // only act when the page is fully loaded
    if (!tab.url) {
      return;
    }
    if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
      return;
    }

    queryCookiesForUrl(tab.url)
      .then((result) => storeSnapshot(tabId, result.cookies))
      .catch((err) => console.error("[Track the Tracker] Snapshot failed:", err));
  });

  // -------------------------------------------------------------------------
  // CLEANUP — remove the snapshot when a tab is closed.
  //
  // chrome.storage.session is cleared on browser restart anyway, but removing
  // snapshots for closed tabs prevents the store growing indefinitely during
  // a long browser session with many tabs opened and closed.
  // -------------------------------------------------------------------------
  chrome.tabs.onRemoved.addListener((tabId) => {
    clearSnapshot(tabId).catch((err) =>
      console.error("[Track the Tracker] Snapshot cleanup failed:", err),
    );
  });

  // -------------------------------------------------------------------------
  // Message handler: GET_COOKIES
  //
  // The popup sends a GetCookiesMessage with the active tab's URL and tabId.
  // We fetch the current cookies, then diff them against the page-load snapshot
  // so the popup can prominently show which cookies are brand new.
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener(
    (
      message: GetCookiesMessage,
      _sender,
      sendResponse: (response: GetCookiesResponse) => void,
    ) => {
      if (message.type !== "GET_COOKIES") {
        return false;
      } // let other handlers process it

      // Both queryCookiesForUrl and diffWithSnapshot are async — we chain them,
      // then call sendResponse with the merged result.
      // Returning `true` keeps the message channel open until sendResponse fires.
      queryCookiesForUrl(message.url)
        .then(async (result) => {
          const diff = await diffWithSnapshot(message.tabId, result.cookies);
          const response: GetCookiesResponse = {
            cookies: result.cookies,
            newSinceLoad: diff.newCookies,
            changedSinceLoad: diff.changedCookies,
            queriedAt: result.queriedAt,
            snapshotTakenAt: diff.snapshotTakenAt,
          };
          sendResponse(response);
        })
        .catch((err) => {
          console.error("[Track the Tracker] Cookie query failed:", err);
          sendResponse({
            cookies: [],
            newSinceLoad: [],
            changedSinceLoad: [],
            queriedAt: new Date().toISOString(),
            snapshotTakenAt: null,
          });
        });

      return true; // keep message channel open for async response
    },
  );
});
