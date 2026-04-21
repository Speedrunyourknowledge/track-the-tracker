/**
 * Popup entry — runs when the user clicks the extension icon.
 * Communicates with the background service worker via chrome.runtime.sendMessage
 */

import type {
  GetCookiesResponse,
  CookieInfo,
  GetAlertsResponse,
  GetPostRequestsResponse,
  ClearPiiBadgeMessage,
  ClearCookieBadgeMessage,
} from "../../features/cookies/types";

const app = document.getElementById("app")!;

const TAB_BTN_BASE = "padding:6px 14px;border:none;background:none;cursor:pointer;font-size:0.85rem;border-bottom:2px solid transparent;font-family:inherit;";
const TAB_BTN_ACTIVE = TAB_BTN_BASE + "border-bottom-color:#f97316;font-weight:bold;color:#c2410c;";
const TAB_BTN_INACTIVE = TAB_BTN_BASE + "color:#555;";

// Holds the active tab's id once chrome.tabs.query resolves, so event handlers
// wired up before loadData completes can still send the correct badge messages
let activeTabId: number | undefined;

// Tracks which tab panel is currently shown so reload can restore it
let activeTab: "cookies" | "requests" = "cookies";

// The seenCategories snapshot returned by GET_ALERTS, sent back in CLEAR_PII_BADGE
// so the background can detect categories that arrived after the popup loaded
let activeSentCategories: string[] = [];

// Pending timer that makes the body visible after a delay if data hasn't loaded yet.
// Cancelled and replaced by revealBody() when real data arrives before the deadline
let spinnerFallbackTimer: ReturnType<typeof setTimeout> | undefined;

// Makes the popup body visible. Cancels the spinner fallback timer if still pending.
// Safe to call multiple times
function revealBody(): void {
  if (spinnerFallbackTimer !== undefined) {
    clearTimeout(spinnerFallbackTimer);
    spinnerFallbackTimer = undefined;
  }
  document.body.style.visibility = "visible";
}

// Renders the tab bar skeleton. Body stays hidden — revealBody() is called once
// real data is ready (or after a timeout) so the spinner never briefly flashes
function showLoading(): void {
  app.innerHTML = `
    <div id="tab-bar" style="display:flex;border-bottom:1px solid #e5e7eb;margin-bottom:10px;">
      <button id="tab-btn-cookies" style="${TAB_BTN_ACTIVE}">Cookies</button>
      <button id="tab-btn-requests" style="${TAB_BTN_INACTIVE}">Requests</button>
    </div>
    <div id="panel-cookies">
      <div style="display:flex;align-items:center;gap:8px;font-size:0.85rem;">
        <span class="spinner"></span>
        <span>Cookies loading. <span style="color:#aaa;">Sites with many trackers take a moment to scan.</span></span>
      </div>
    </div>
    <div id="panel-requests" style="display:none;"></div>
  `;

  const btnCookies = document.getElementById("tab-btn-cookies")!;
  const btnRequests = document.getElementById("tab-btn-requests")!;
  const panelCookies = document.getElementById("panel-cookies")!;
  const panelRequests = document.getElementById("panel-requests")!;

  btnCookies.addEventListener("click", () => {
    activeTab = "cookies";
    panelCookies.style.display = "";
    panelRequests.style.display = "none";
    btnCookies.setAttribute("style", TAB_BTN_ACTIVE);
    btnRequests.setAttribute("style", TAB_BTN_INACTIVE);
    if (activeTabId !== undefined) {
      sendMessageAsync<object>({ type: "CLEAR_COOKIE_BADGE", tabId: activeTabId } satisfies ClearCookieBadgeMessage).catch(() => {});
    }
  });

  btnRequests.addEventListener("click", () => {
    activeTab = "requests";
    panelCookies.style.display = "none";
    panelRequests.style.display = "";
    btnCookies.setAttribute("style", TAB_BTN_INACTIVE);
    btnRequests.setAttribute("style", TAB_BTN_ACTIVE);
    document.getElementById("alert-dot")?.remove();
    if (activeTabId !== undefined) {
      sendMessageAsync<object>({
        type: "CLEAR_PII_BADGE",
        tabId: activeTabId,
        seenAtView: activeSentCategories,
      } satisfies ClearPiiBadgeMessage).catch(() => {});
    }
  });
}

showLoading();

// Reload the popup so newly arrived alerts are fetched and displayed.
// Saves the current tab to sessionStorage so it can be restored after reload —
// sessionStorage is cleared when the popup is opened fresh (new window context)
document.getElementById("reload-btn")!.addEventListener("click", () => {
  sessionStorage.setItem("popup-active-tab", activeTab);
  location.reload();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Builds the alerts section HTML string
function buildAlertsHtml(response: GetAlertsResponse): string {
  const alerts = response.alerts;
  if (alerts.length === 0) {
    return "";
  }

  const piiAlerts      = alerts.filter(a => a.type === "pii_exfiltration");
  const locationAlerts = alerts.filter(a => a.type === "location_tracking");
  const trackingAlerts = alerts.filter(a => a.type === "action_tracking");

  function alertItemsHtml(group: typeof alerts): string {
    return group.map(a => `
      <div style="margin-bottom: 8px;">
        <div style="color: #9a3412; margin-top: 2px;">To: <code>${escapeHtml(a.domain)}</code></div>
        <div style="margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap;">
          ${a.labels.map(l => `<span style="background: #ffedd5; border: 1px solid #fed7aa; color: #9a3412; padding: 2px 6px; border-radius: 12px; font-size: 0.75rem;">${escapeHtml(l)}</span>`).join("")}
        </div>
        ${a.matchSnippets.length > 0 ? `<div style="margin-top:5px;">${a.matchSnippets.map(s => `<code style="display:block;font-size:0.7rem;background:#fffbf7;border:1px solid #fed7aa;border-radius:3px;padding:4px 6px;margin-top:2px;word-break:break-all;">${escapeHtml(s)}</code>`).join("")}</div>` : ""}
      </div>`).join("");
  }

  function sectionHtml(emoji: string, label: string, group: typeof alerts): string {
    if (group.length === 0) {
      return "";
    }
    return `
      <details style="margin-bottom: 8px;">
        <summary style="cursor:pointer;font-weight:bold;">
          ${emoji} ${label} <span style="background:#ffedd5;border:1px solid #fed7aa;color:#9a3412;padding:1px 7px;border-radius:10px;font-size:0.75rem;font-weight:normal;">${group.length}</span>
        </summary>
        <div style="margin-top:6px;padding-left:4px;">
          ${alertItemsHtml(group)}
        </div>
      </details>`;
  }

  return `
    <div style="background-color: #fff7ed; border: 1px solid #f97316; border-radius: 4px; padding: 12px; margin-bottom: 12px; font-size: 0.85rem;">
      <h3 style="margin: 0 0 8px 0; color: #c2410c;">⚠️ Privacy Alerts</h3>
      ${sectionHtml("🛑", "PII Exfiltration", piiAlerts)}
      ${sectionHtml("📍", "Location Tracking", locationAlerts)}
      ${sectionHtml("👀", "Action Tracking", trackingAlerts)}
    </div>`;
}

// Builds the third-party POST requests section HTML string
function buildPostRequestsHtml(response: GetPostRequestsResponse, alerts: GetAlertsResponse): string {
  const { requests } = response;
  if (requests.length === 0) {
    return "";
  }
  // Domains that triggered at least one alert — highlighted in the list so
  // the user knows expanding that row will show the relevant fields
  const alertedDomains = new Set(alerts.alerts.map(a => a.domain));
  return `
    <div style="border: 1px solid #ddd; border-radius: 4px; padding: 12px; margin-bottom: 12px; font-size: 0.85rem;">
      <p style="margin: 0 0 8px 0; font-weight: bold;">Third-party POST Requests (${requests.length})</p>
      ${requests.map(r => {
        const PILL_MAX_CHARS = 24;
        const pillBase = "display:inline-block;white-space:nowrap;padding:1px 5px;border-radius:10px;font-size:0.72rem;vertical-align:middle;";
        const fieldTags = r.fields.length > 0
          ? r.fields.map(f => {
              const label = f.length > PILL_MAX_CHARS ? f.slice(0, PILL_MAX_CHARS) + "\u2026" : f;
              const isPii = r.piiFields.includes(f);
              const isAction = r.actionFields.includes(f);
              const style = isPii || isAction
                ? `${pillBase}background:#ffedd5;border:1px solid #f97316;color:#9a3412;`
                : `${pillBase}background:#f3f4f6;border:1px solid #d1d5db;color:#374151;`;
              return `<span style="${style}">${escapeHtml(label)}</span>`;
            }).join(" ")
          : "<span style='color:#aaa;font-size:0.78rem;'>No fields parsed</span>";
        const domainStyle = alertedDomains.has(r.domain)
          ? "font-size: 0.78rem; color: #c2410c; font-weight: bold;"
          : "font-size: 0.78rem;";

        return `
          <details style="margin-bottom: 6px;">
            <summary style="cursor: pointer; word-break: break-all;">
              <code style="${domainStyle}">${escapeHtml(r.domain)}</code>${r.count > 1 ? `<span style="margin-left:5px;color:#888;font-size:0.72rem;">&times;${r.count}</span>` : ""}
            </summary>
            <div style="margin-top: 6px; padding-left: 8px; font-size: 0.78rem; color: #555; word-break: break-all;">
              <div>URL: <code>${escapeHtml(r.url)}</code></div>
              <div style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px;">${fieldTags}</div>
            </div>
          </details>
        `;
      }).join("")}
    </div>`;
}

// Builds the cookies section HTML string
function buildCookiesHtml(response: GetCookiesResponse): string {
  const { cookies, queriedAt } = response;

  if (cookies.length === 0) {
    return "<p>No cookies found for this page.</p>";
  }

  const byDomain = (a: CookieInfo, b: CookieInfo) => a.domain.localeCompare(b.domain);

  const firstParty = cookies.filter((c) => !c.isThirdParty).sort(byDomain);
  const thirdParty = cookies.filter((c) => c.isThirdParty);
  const labeled = thirdParty.filter((c) => !c.isSecurityCookie && c.trackerCategory !== null).sort(byDomain);
  const unlabeled = thirdParty.filter((c) => !c.isSecurityCookie && c.trackerCategory === null).sort(byDomain);
  const securityCookies = thirdParty.filter((c) => c.isSecurityCookie).sort(byDomain);

  const trackersSubsection = labeled.length > 0 ? `
    <details open style="margin-top:8px;margin-left:8px;">
      <summary style="cursor:pointer;font-weight:bold;color:#b91c1c;">
        Trackers (${labeled.length})
      </summary>
      ${cookieListHtml(labeled)}
    </details>
  ` : "";

  const unlabeledSubsection = unlabeled.length > 0 ? `
    <details style="margin-top:8px;margin-left:8px;">
      <summary style="cursor:pointer;font-weight:bold;color:#6b7280;">
        Unlabeled (${unlabeled.length})
      </summary>
      ${cookieListHtml(unlabeled)}
    </details>
  ` : "";

  const securitySubsection = securityCookies.length > 0 ? `
    <details style="margin-top:8px;margin-left:8px;">
      <summary style="cursor:pointer;font-weight:bold;color:#c99502;">
        Security (Harmless) (${securityCookies.length})
      </summary>
      ${cookieListHtml(securityCookies)}
    </details>
  ` : "";

  const hasNoSubsections = labeled.length === 0 && unlabeled.length === 0 && securityCookies.length === 0;

  // Open third-party by default if present, otherwise open first-party
  const hasThirdParty = thirdParty.length > 0;
  const thirdPartyOpen = hasThirdParty ? " open" : "";
  const firstPartyOpen = hasThirdParty ? "" : " open";

  return `
    <p style="font-size:0.75rem;color:#888;margin:0 0 6px">Retrieved at ${new Date(queriedAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
    <details${thirdPartyOpen} style="margin-top:4px;">
      <summary style="cursor:pointer;font-weight:bold;color:#111827;">Third-party (${thirdParty.length})</summary>
      ${hasNoSubsections ? "<p style='margin:4px 0;color:#888'>None</p>" : ""}
      ${trackersSubsection}
      ${unlabeledSubsection}
      ${securitySubsection}
    </details>
    <details${firstPartyOpen} style="margin-top:4px;">
      <summary style="cursor:pointer;font-weight:bold;color:#059669;">First-party (${firstParty.length})</summary>
      ${cookieListHtml(firstParty)}
    </details>`;
}

// Builds an HTML list for a list of CookieInfo objects
function cookieListHtml(cookies: CookieInfo[]): string {
  if (cookies.length === 0) {
    return "<p style='margin:4px 0;color:#888'>None</p>";
  }

  return cookies
    .map((c) => {
      const name = escapeHtml(c.name);
      const domain = escapeHtml(c.domain);
      const borderStyle = "border:1px solid #ddd;";
      // If the domain name is long, put it on its own line so the cookie name
      // gets a full line beneath it
      const nameAndDomain = domain.length > 20
        ? `<div style="display:flex;justify-content:flex-end;margin-bottom:2px;">
             <span style="color:#888;white-space:nowrap;">${domain}</span>
           </div>
           <strong style="word-break:break-all;">${name}</strong>`
        : `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
             <strong style="word-break:break-all;">${name}</strong>
             <span style="color:#888;white-space:nowrap;flex-shrink:0;">${domain}</span>
           </div>`;
      const partyLabel = c.isThirdParty
        ? (c.isSecurityCookie ? "🟡 Security" : "🔴 3rd party")
        : "🟢 1st party";
      // Harmless categories use a yellow pill; all other tracker categories use the standard orange
      const harmlessCategories = new Set(["Anti-fraud", "ConsentManagers"]);
      const isHarmlessCategory = c.trackerCategory !== null && harmlessCategories.has(c.trackerCategory);
      const trackerLabel = c.trackerCategory !== null
        ? `<div style="margin-top:4px;">
             <span style="${isHarmlessCategory ? "background:#fefce8;border:1px solid #fde047;color:#854d0e;" : "background:#ffedd5;border:1px solid #fed7aa;color:#9a3412;"}padding:2px 6px;border-radius:12px;font-size:0.75rem;">${escapeHtml(c.trackerCategory)}</span>
           </div>`
        : "";
      return `
      <div style="${borderStyle}border-radius:4px;padding:6px 8px;margin:4px 0;font-size:0.8rem;">
        ${nameAndDomain}
        <span>Expires: ${escapeHtml(c.expiresFormatted)}</span>
        &nbsp;|&nbsp;
        <span>Secure: ${c.secure ? "✅" : "❌"}</span>
        &nbsp;|&nbsp;
        <span>HttpOnly: ${c.httpOnly ? "✅" : "❌"}</span>
        &nbsp;|&nbsp;
        <span>SameSite: ${escapeHtml(c.sameSite)}</span>
        &nbsp;|&nbsp;
        <span>${partyLabel}</span>
        ${trackerLabel}
        <br/>
        <div style="display:flex;align-items:baseline;gap:4px;margin-top:2px;">
          <span style="color:#555;flex-shrink:0;">Value:</span>
          <code style="
            flex:1;
            display:-webkit-box;
            -webkit-line-clamp:2;
            -webkit-box-orient:vertical;
            overflow:hidden;
            word-break:break-all;
            background:#f5f5f5;
            border-radius:3px;
            padding:2px 4px;
            font-size:0.75rem;
          ">${escapeHtml(c.value) || "<em style='color:#aaa'>empty</em>"}</code>
        </div>
      </div>`;
    })
    .join("");
}

// Escapes HTML special characters to prevent XSS from cookie data
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Main: get the active tab URL + tabId, then ask the background for cookies
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendMessageAsync<T = unknown>(message: unknown, timeoutMs = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    // Timeout guards against the service worker accepting the message then
    // terminating before it calls sendResponse (an MV3 race condition that
    // leaves the popup stuck on "Loading cookies…" indefinitely)
    const timer = setTimeout(() => {
      reject(new Error("timeout"));
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (response: T) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        // lastError is {message: string}, not an Error — wrap it so the catch
        // block can display the message string instead of "[object Object]"
        reject(new Error(chrome.runtime.lastError.message ?? "Extension messaging error"));
      }
      else {
        resolve(response);
      }
    });
  });
}

async function loadData(url: string, tabId: number): Promise<void> {
  activeTabId = tabId;
  try {
    const [alertsRes, postReqRes, cookiesRes] = await Promise.all([
      sendMessageAsync<GetAlertsResponse>({ type: "GET_ALERTS", tabId }),
      sendMessageAsync<GetPostRequestsResponse>({ type: "GET_POST_REQUESTS", tabId }),
      sendMessageAsync<GetCookiesResponse>({ type: "GET_COOKIES", url, tabId }),
    ]);

    const hasAlerts = alertsRes.alerts.length > 0 && !alertsRes.alertsViewed;

    // Snapshot the categories the popup sees so CLEAR_PII_BADGE can detect
    // any that arrived after this load (and therefore weren't shown to the user)
    activeSentCategories = alertsRes.seenCategories;

    // Cookie store was locked and returned nothing — wait briefly and retry
    if (cookiesRes.timedOut && cookiesRes.cookies.length === 0) {
      await delay(1500);
      return loadData(url, tabId);
    }

    // Update only the panel content — the tab bar was already rendered by
    // showLoading() so there is no structural flash here
    const panelCookies = document.getElementById("panel-cookies")!;
    const panelRequests = document.getElementById("panel-requests")!;
    const btnRequests = document.getElementById("tab-btn-requests")!;

    panelCookies.innerHTML = buildCookiesHtml(cookiesRes);
    panelRequests.innerHTML = `
      <p style="font-size:0.75rem;color:#888;margin:0 0 6px">Retrieved at ${new Date(postReqRes.retrievedAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
      ${buildAlertsHtml(alertsRes)}${buildPostRequestsHtml(postReqRes, alertsRes)}
    `;

    if (hasAlerts) {
      btnRequests.innerHTML = `Requests<span id="alert-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f97316;margin-left:5px;vertical-align:middle;position:relative;top:-1px;"></span>`;
    }
    else {
      btnRequests.textContent = "Requests";
    }

    sendMessageAsync<object>({ type: "CLEAR_COOKIE_BADGE", tabId } satisfies ClearCookieBadgeMessage).catch(() => {});

    // Restore the tab the user was on before reloading, if any
    const savedTab = sessionStorage.getItem("popup-active-tab");
    sessionStorage.removeItem("popup-active-tab");
    if (savedTab === "requests") {
      document.getElementById("tab-btn-requests")!.click();
    }

    // Panels are filled — reveal the popup now that real content is in place
    revealBody();
  }
  catch {
    // Retry on all errors — the service worker may have been killed mid-flight
    // (an MV3 race) or the cookie store may still be locked. A later attempt
    // will succeed once the page settles
    await delay(1500);
    return loadData(url, tabId);
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  const url = tab?.url;
  const tabId = tab?.id;

  if (!url || tabId === undefined) {
    app.textContent = "Could not determine the current tab.";
    revealBody();
    return;
  }

  loadData(url, tabId);
});

// Show the body with the loading spinner if data takes longer than 300ms.
// This prevents a visible flash for fast loads while still showing progress
// for slow ones
spinnerFallbackTimer = setTimeout(() => {
  spinnerFallbackTimer = undefined;
  document.body.style.visibility = "visible";
}, 300);
