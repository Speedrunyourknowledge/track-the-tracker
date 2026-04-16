// Popup entry — runs when the user clicks the extension icon.
//
// Communicates with the background service worker via chrome.runtime.sendMessage.

import type {
  GetCookiesResponse,
  CookieInfo,
  GetAlertsResponse,
  GetPostRequestsResponse,
  ClearPiiBadgeMessage,
  ClearCookieBadgeMessage,
} from "../../features/cookies/types";

const app = document.getElementById("app")!;
app.textContent = "Loading cookies…";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds the alerts section HTML string. */
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

/** Builds the third-party POST requests section HTML string. */
function buildPostRequestsHtml(response: GetPostRequestsResponse): string {
  const { requests } = response;
  if (requests.length === 0) {
    return "";
  }
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

        return `
          <details style="margin-bottom: 6px;">
            <summary style="cursor: pointer; word-break: break-all;">
              <code style="font-size: 0.78rem;${r.hasCookie ? "color:#c2410c;font-weight:bold;" : ""}">${escapeHtml(r.domain)}</code>${r.count > 1 ? `<span style="margin-left:5px;color:#888;font-size:0.72rem;">&times;${r.count}</span>` : ""}
            </summary>
            <div style="margin-top: 6px; padding-left: 8px; font-size: 0.78rem; color: #555; word-break: break-all;">
              <div>URL: <code>${escapeHtml(r.url)}</code></div>
              ${r.hasCookie ? `<div style="margin-top:4px;"><span style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;padding:1px 6px;border-radius:10px;font-size:0.72rem;">cookie-linked</span></div>` : ""}
              <div style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px;">${fieldTags}</div>
            </div>
          </details>
        `;
      }).join("")}
    </div>`;
}

/** Builds the cookies section HTML string. */
function buildCookiesHtml(response: GetCookiesResponse): string {
  const { cookies, queriedAt } = response;

  if (cookies.length === 0) {
    return "<p>No cookies found for this page.</p>";
  }

  const byDomain = (a: CookieInfo, b: CookieInfo) => a.domain.localeCompare(b.domain);

  const firstParty = cookies.filter((c) => !c.isThirdParty).sort(byDomain);
  const thirdParty = cookies.filter((c) => c.isThirdParty);
  const trackers = thirdParty.filter((c) => !c.isSecurityCookie).sort(byDomain);
  const securityCookies = thirdParty.filter((c) => c.isSecurityCookie).sort(byDomain);

  const thirdPartySummaryStyle = trackers.length > 0
    ? "cursor:pointer;font-weight:bold;color:#e05320;"
    : "cursor:pointer;font-weight:bold;";

  const trackerList = trackers.length > 0
    ? cookieListHtml(trackers)
    : securityCookies.length > 0
      ? ""
      : "<p style='margin:4px 0;color:#888'>None</p>";

  const securitySubsection = securityCookies.length > 0 ? `
    <details style="margin-top:8px;margin-left:8px;">
      <summary style="cursor:pointer;font-weight:bold;color:#c99502;">
        Security (Harmless) (${securityCookies.length})
      </summary>
      ${cookieListHtml(securityCookies)}
    </details>
  ` : "";

  return `
    <p style="font-size:0.75rem;color:#888;margin:0 0 6px">Retrieved at ${new Date(queriedAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
    <p style="font-weight:bold;margin:8px 0 4px;">
      All cookies — ${thirdParty.length} third-party, ${firstParty.length} first-party
    </p>
    <details open style="margin-top:4px;">
      <summary style="${thirdPartySummaryStyle}">Third-party (${thirdParty.length})</summary>
      ${securitySubsection}
      ${trackerList}
    </details>
    <details open style="margin-top:4px;">
      <summary style="cursor:pointer;font-weight:bold;">First-party (${firstParty.length})</summary>
      ${cookieListHtml(firstParty)}
    </details>`;
}

/** Builds an HTML string for a list of CookieInfo objects. */
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
      // gets a full line beneath it.
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
// ---------------------------------------------------------------------------

function sendMessageAsync<T = unknown>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      }
 else {
        resolve(response);
      }
    });
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  const tab = tabs[0];
  const url = tab?.url;
  const tabId = tab?.id;

  if (!url || tabId === undefined) {
    app.textContent = "Could not determine the current tab.";
    return;
  }

  try {
    const [alertsRes, postReqRes, cookiesRes] = await Promise.all([
      sendMessageAsync<GetAlertsResponse>({ type: "GET_ALERTS", tabId }),
      sendMessageAsync<GetPostRequestsResponse>({ type: "GET_POST_REQUESTS", tabId }),
      sendMessageAsync<GetCookiesResponse>({ type: "GET_COOKIES", url, tabId }),
    ]);

    const hasAlerts = alertsRes.alerts.length > 0 && !alertsRes.alertsViewed;

    const alertDot = hasAlerts
      ? `<span id="alert-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f97316;margin-left:5px;vertical-align:middle;position:relative;top:-1px;"></span>`
      : "";

    const tabBtnBase = "padding:6px 14px;border:none;background:none;cursor:pointer;font-size:0.85rem;border-bottom:2px solid transparent;font-family:inherit;";
    const tabBtnActive = tabBtnBase + "border-bottom-color:#f97316;font-weight:bold;color:#c2410c;";
    const tabBtnInactive = tabBtnBase + "color:#555;";

    app.innerHTML = `
      <div id="tab-bar" style="display:flex;border-bottom:1px solid #e5e7eb;margin-bottom:10px;">
        <button id="tab-btn-cookies" style="${tabBtnActive}">Cookies</button>
        <button id="tab-btn-requests" style="${tabBtnInactive}">Requests${alertDot}</button>
      </div>
      <div id="panel-cookies">${buildCookiesHtml(cookiesRes)}</div>
      <div id="panel-requests" style="display:none;"><p style="font-size:0.75rem;color:#888;margin:0 0 6px">Retrieved at ${new Date(postReqRes.retrievedAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>${buildAlertsHtml(alertsRes)}${buildPostRequestsHtml(postReqRes)}</div>
    `;

    // Attach tab switching listeners — inline onclick is blocked by MV3 CSP.
    const btnCookies = document.getElementById("tab-btn-cookies")!;
    const btnRequests = document.getElementById("tab-btn-requests")!;
    const panelCookies = document.getElementById("panel-cookies")!;
    const panelRequests = document.getElementById("panel-requests")!;

    btnCookies.addEventListener("click", () => {
      panelCookies.style.display = "";
      panelRequests.style.display = "none";
      btnCookies.setAttribute("style", tabBtnActive);
      btnRequests.setAttribute("style", tabBtnInactive);
      // Dismiss the cookie dot now that the user is viewing the cookies tab.
      sendMessageAsync<object>({ type: "CLEAR_COOKIE_BADGE", tabId } satisfies ClearCookieBadgeMessage).catch(() => {});
    });

    btnRequests.addEventListener("click", () => {
      panelCookies.style.display = "none";
      panelRequests.style.display = "";
      btnCookies.setAttribute("style", tabBtnInactive);
      btnRequests.setAttribute("style", tabBtnActive);
      // Remove the orange dot once the user has seen the alerts tab.
      document.getElementById("alert-dot")?.remove();
      // Dismiss the PII badge now that the user is viewing the alerts.
      sendMessageAsync<object>({ type: "CLEAR_PII_BADGE", tabId } satisfies ClearPiiBadgeMessage).catch(() => {});
    });

    // The Cookies tab is shown by default on popup open — clear the cookie dot immediately.
    sendMessageAsync<object>({ type: "CLEAR_COOKIE_BADGE", tabId } satisfies ClearCookieBadgeMessage).catch(() => {});
  }
  catch (err: unknown) {
    app.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
});
