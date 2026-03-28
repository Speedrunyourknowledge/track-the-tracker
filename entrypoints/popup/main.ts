// Popup entry — runs when the user clicks the extension icon.
//
// WHEN IS THIS CODE EXECUTED?
// Only when the popup window is opened by the user clicking the toolbar icon.
// It is NOT running in the background, and it is NOT automatically triggered
// by page navigations or cookie changes. Each time you open the popup, this
// script runs fresh and fetches a new snapshot of the current cookies.
//
// WHAT YOU SEE IN THE POPUP (three sections, in order):
//
//  1. "New since page load" — cookies that were NOT in the jar when the page
//     first loaded. These are the most likely candidates from an "Allow cookies"
//     banner click, a login form, or a third-party script that loaded lazily.
//     Close the popup, interact with the page, then re-open to see this section
//     populated with whatever was just written.
//
//  2. "Changed since page load" — cookies that existed at page load but whose
//     value was updated (e.g. a session token that was rotated after login).
//
//  3. "All cookies" — everything currently in the jar for this URL, split into
//     first-party vs. third-party, including pre-existing ones.
//
// NOTE: If the tab was already open before the extension was running, there is
// no baseline snapshot, and sections 1 and 2 will show a notice instead.
//
// Communicates with the background service worker via chrome.runtime.sendMessage.

import type { GetCookiesMessage, GetCookiesResponse, CookieInfo } from "../../features/cookies/types";

const app = document.getElementById("app")!;
app.textContent = "Loading cookies…";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Top-level renderer — builds the full popup UI from a GetCookiesResponse. */
function renderCookies(response: GetCookiesResponse): void {
  const { cookies, newSinceLoad, changedSinceLoad, queriedAt, snapshotTakenAt } = response;

  if (cookies.length === 0) {
    app.innerHTML = "<p>No cookies found for this page.</p>";
    return;
  }

  // Split all cookies into first-party and third-party for the "all cookies" view.
  const firstParty = cookies.filter((c) => !c.isThirdParty);
  const thirdParty = cookies.filter((c) => c.isThirdParty);

  // ---- Section 1: New since page load ----------------------------------------
  // This is the most important section — shown open and highlighted so it's the
  // first thing the user sees after clicking an "Allow cookies" banner.
  //
  // snapshotTakenAt === null means the background has no baseline for this tab
  // (e.g. the tab was open before the extension started). We warn the user so
  // they know to navigate again to establish a baseline.
  const newSectionHtml =
    snapshotTakenAt === null
      ? `<p style="color:#888;font-size:0.8rem;">
           No page-load snapshot available for this tab.<br>
           Reload the page to establish a baseline, then re-open the popup.
         </p>`
      : newSinceLoad.length === 0
        ? `<p style="color:#888;font-size:0.8rem;">None — no new cookies since page load (snapshot taken ${snapshotTakenAt}).</p>`
        : cookieListHtml(newSinceLoad);

  // ---- Section 2: Changed since page load ----------------------------------------
  const changedSectionHtml =
    snapshotTakenAt !== null && changedSinceLoad.length > 0
      ? `<details style="margin-top:8px;">
           <summary style="cursor:pointer;font-weight:bold;color:#b45309;">
             Changed since page load (${changedSinceLoad.length})
           </summary>
           ${cookieListHtml(changedSinceLoad)}
         </details>`
      : "";

  app.innerHTML = `
    <p style="font-size:0.75rem;color:#888;margin:0 0 6px">Queried at ${queriedAt}</p>

    <details open style="border:2px solid #ef4444;border-radius:6px;padding:6px 8px;margin-bottom:8px;">
      <summary style="cursor:pointer;font-weight:bold;color:#ef4444;">
        🆕 New since page load (${newSinceLoad.length})
      </summary>
      ${newSectionHtml}
    </details>

    ${changedSectionHtml}

    <details style="margin-top:8px;">
      <summary style="cursor:pointer;font-weight:bold;">
        All cookies — ${thirdParty.length} third-party, ${firstParty.length} first-party
      </summary>
      <details open style="margin-top:4px;">
        <summary style="cursor:pointer;">Third-party (${thirdParty.length})</summary>
        ${cookieListHtml(thirdParty)}
      </details>
      <details style="margin-top:4px;">
        <summary style="cursor:pointer;">First-party (${firstParty.length})</summary>
        ${cookieListHtml(firstParty)}
      </details>
    </details>
  `;
}

/** Builds an HTML string for a list of CookieInfo objects. */
function cookieListHtml(cookies: CookieInfo[]): string {
  if (cookies.length === 0) {
    return "<p style='margin:4px 0;color:#888'>None</p>";
  }

  return cookies
    .map(
      (c) => `
      <div style="border:1px solid #ddd;border-radius:4px;padding:6px 8px;margin:4px 0;font-size:0.8rem;">
        <strong>${escapeHtml(c.name)}</strong>
        <span style="float:right;color:#888">${escapeHtml(c.domain)}</span>
        <br/>
        <span>Expires: ${escapeHtml(c.expiresFormatted)}</span>
        &nbsp;|&nbsp;
        <span>Secure: ${c.secure ? "✅" : "❌"}</span>
        &nbsp;|&nbsp;
        <span>HttpOnly: ${c.httpOnly ? "✅" : "❌"}</span>
        &nbsp;|&nbsp;
        <span>SameSite: ${escapeHtml(c.sameSite)}</span>
        &nbsp;|&nbsp;
        <span>${c.isThirdParty ? "🔴 3rd party" : "🟢 1st party"}</span>
        <br/>
        <div style="display:flex;align-items:baseline;gap:4px;margin-top:2px;">
          <span style="color:#555;flex-shrink:0;">Value:</span>
          <code style="
            flex:1;
            overflow-x:auto;
            white-space:pre-wrap;
            word-break:break-all;
            background:#f5f5f5;
            border-radius:3px;
            padding:2px 4px;
            font-size:0.75rem;
          ">${escapeHtml(c.value) || "<em style='color:#aaa'>empty</em>"}</code>
        </div>
      </div>`,
    )
    .join("");
}

/** Escapes HTML special characters to prevent XSS from cookie data. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Main: get the active tab URL + tabId, then ask the background for cookies.
//
// HOW TO TEST THIS MANUALLY:
//  1. Run `npm run dev` to build in watch mode.
//  2. Open chrome://extensions, enable "Developer mode".
//  3. Click "Load unpacked" → select the `.output/chrome-mv3` folder.
//  4. Navigate to a site with a cookie banner (e.g. https://bbc.com).
//  5. BEFORE clicking the banner, open the popup — "New since page load" is empty.
//  6. Close the popup, click "Accept all cookies" on the banner.
//  7. Re-open the popup — the "New since page load" section now shows exactly
//     what the banner set, clearly separated from everything else.
//  8. Cross-check in DevTools → Application → Cookies to verify.
//
// WHY WE PASS tabId:
//  The background stores a cookie snapshot per tab (keyed by tabId). Without
//  the tabId, the background wouldn't know which snapshot to diff against.
// ---------------------------------------------------------------------------

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  const url = tab?.url;
  const tabId = tab?.id;

  if (!url || tabId === undefined) {
    app.textContent = "Could not determine the current tab.";
    return;
  }

  const message: GetCookiesMessage = { type: "GET_COOKIES", url, tabId };

  chrome.runtime.sendMessage(message, (response: GetCookiesResponse) => {
    if (chrome.runtime.lastError) {
      app.textContent = `Error: ${chrome.runtime.lastError.message}`;
      return;
    }
    renderCookies(response);
  });
});
