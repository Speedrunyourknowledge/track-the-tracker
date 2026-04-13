// Popup entry — runs when the user clicks the extension icon.
//
// Communicates with the background service worker via chrome.runtime.sendMessage.

import type {
  GetCookiesResponse,
  CookieInfo,
  GetAlertsResponse,
  GetPostRequestsResponse,
} from "../../features/cookies/types";

const app = document.getElementById("app")!;
app.textContent = "Loading cookies…";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Top-level renderer — builds the alerts UI block. */
function renderAlerts(response: GetAlertsResponse): void {
  const alerts = response.alerts;
  if (alerts.length === 0) {
    return;
  }

  const alertsHtml = `
    <div style="background-color: #fff7ed; border: 1px solid #f97316; border-radius: 4px; padding: 12px; margin-bottom: 12px; font-size: 0.85rem;">
      <h3 style="margin: 0 0 8px 0; color: #c2410c;">⚠️ Privacy Alerts</h3>
      ${alerts.map(a => `
        <div style="margin-bottom: 8px;">
          <strong>${a.type === 'pii_exfiltration' ? '🛑 PII Exfiltration' : '👀 Action Tracking'}</strong><br/>
          <div style="color: #9a3412; margin-top: 2px;">To: <code>${escapeHtml(a.domain)}</code></div>
          <div style="margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap;">
            ${a.details.map(d => `<span style="background: #ffedd5; border: 1px solid #fed7aa; color: #9a3412; padding: 2px 6px; border-radius: 12px; font-size: 0.75rem;">${escapeHtml(d)}</span>`).join("")}
          </div>
          ${a.payload ? `
            <details style="margin-top: 6px;">
              <summary style="cursor: pointer; color: #9a3412; font-size: 0.75rem;">View payload</summary>
              <code style="display: block; margin-top: 4px; padding: 4px 6px; background: #ffedd5; border-radius: 3px; font-size: 0.72rem; word-break: break-all; white-space: pre-wrap;">${escapeHtml(a.payload)}</code>
            </details>
          ` : ""}
        </div>
      `).join("")}
    </div>
  `;

  app.insertAdjacentHTML("afterbegin", alertsHtml);
}

/** Top-level renderer — builds the third-party POST requests UI block. */
function renderPostRequests(response: GetPostRequestsResponse): void {
  const requests = response.requests;
  if (requests.length === 0) {
    return;
  }

  const requestsHtml = `
    <div style="border: 1px solid #ddd; border-radius: 4px; padding: 12px; margin-bottom: 12px; font-size: 0.85rem;">
      <p style="margin: 0 0 8px 0; font-weight: bold;">Third-party POST Requests (${requests.length})</p>
      ${requests.map(r => {
        const fieldTags = r.fields.length > 0
          ? r.fields.map(f => {
              const isPii = r.piiFields.includes(f);
              const style = isPii
                ? "background:#ffedd5;border:1px solid #f97316;color:#9a3412;padding:1px 5px;border-radius:10px;font-size:0.72rem;white-space:nowrap;"
                : "background:#f3f4f6;border:1px solid #d1d5db;color:#374151;padding:1px 5px;border-radius:10px;font-size:0.72rem;white-space:nowrap;";
              return `<span style="${style}">${escapeHtml(f)}</span>`;
            }).join(" ")
          : "<span style='color:#aaa;font-size:0.78rem;'>No fields parsed</span>";

        return `
          <details style="margin-bottom: 6px;">
            <summary style="cursor: pointer; word-break: break-all;">
              <code style="font-size: 0.78rem;">${escapeHtml(r.domain)}</code>
            </summary>
            <div style="margin-top: 6px; padding-left: 8px; font-size: 0.78rem; color: #555; word-break: break-all;">
              <div>URL: <code>${escapeHtml(r.url)}</code></div>
              <div style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px;">${fieldTags}</div>
            </div>
          </details>
        `;
      }).join("")}
    </div>
  `;

  app.insertAdjacentHTML("afterbegin", requestsHtml);
}

/** Top-level renderer — builds the full popup UI from a GetCookiesResponse. */
function renderCookies(response: GetCookiesResponse): void {
  const { cookies, queriedAt } = response;

  if (cookies.length === 0) {
    app.innerHTML = "<p>No cookies found for this page.</p>";
    return;
  }

  const byDomain = (a: CookieInfo, b: CookieInfo) => a.domain.localeCompare(b.domain);

  const firstParty = cookies.filter((c) => !c.isThirdParty).sort(byDomain);
  const thirdParty = cookies.filter((c) => c.isThirdParty);
  const trackers = thirdParty.filter((c) => !c.isSecurityCookie).sort(byDomain);
  const securityCookies = thirdParty.filter((c) => c.isSecurityCookie).sort(byDomain);

  // Red only when there are real trackers; security-only third-party cookies
  // are harmless and don't warrant a red alert.
  const thirdPartySummaryStyle = trackers.length > 0
    ? "cursor:pointer;font-weight:bold;color:#ef4444;"
    : "cursor:pointer;font-weight:bold;";

  // Don't show a redundant "None" for trackers when the only third-party
  // cookies present are harmless security ones.
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

  app.innerHTML = `
    <p style="font-size:0.75rem;color:#888;margin:0 0 6px">Queried at ${queriedAt}</p>

    <p style="font-weight:bold;margin:8px 0 4px;">
      All cookies — ${thirdParty.length} third-party, ${firstParty.length} first-party
    </p>

    <details open style="margin-top:4px;">
      <summary style="${thirdPartySummaryStyle}">
        Third-party (${thirdParty.length})
      </summary>
      ${securitySubsection}
      ${trackerList}
    </details>

    <details open style="margin-top:4px;">
      <summary style="cursor:pointer;font-weight:bold;">
        First-party (${firstParty.length})
      </summary>
      ${cookieListHtml(firstParty)}
    </details>
  `;
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

    app.textContent = "";

    // Render in reverse display order using insertAdjacentHTML("afterbegin"):
    // cookies first (bottom), then post requests (middle), then alerts (top).
    renderCookies(cookiesRes);
    renderPostRequests(postReqRes);
    renderAlerts(alertsRes);
  } 
  catch (err: unknown) {
    app.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
});
