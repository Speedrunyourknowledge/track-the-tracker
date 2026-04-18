# Overview

A Chrome extension that reveals cross-site tracking activity as you browse. It inspects the browser's cookie jar to surface third-party tracking cookies, and intercepts outgoing POST requests to flag when PII, location data, or behavioral signals are sent to third-party domains. Results are shown in a popup with a Cookies tab and a Requests tab. The extension icon displays a `!` badge whenever tracking activity is detected.

## Motivation

Most users unknowingly authorize cross-site tracking by clicking "Accept All" on cookie banners. The result is an **Illusion of Privacy**: personal data is routinely collected and sold without transparent user consent. This extension acts as an **Auditor** — not an ad-blocker — revealing tracking activity in real time.

### Core Privacy Problems

- **Privacy Debt** — cookies can be used to track your behavior, and this tracking becomes more pervasive over time as more cookies are accumulated
- **De-Anonymization** — outgoing network requests can send Personally Identifiable Information (PII), such as your email, to third-party servers, linking your true identity to your online activity

## Features

[Screenshots will go here]

### Cookies tab

Shows all cookies currently active for the page, split into:
- **Third-party (trackers)** — cookies from domains other than the current page, flagged in red
- **Third-party (security/harmless)** — known anti-abuse tokens (e.g. Google AEC) that are third-party but not behavioral trackers, flagged in yellow
- **First-party** — cookies from the current site itself, flagged in green

### Requests tab

Shows third-party POST requests observed during the current page load, with field-level highlights for any PII or action-tracking data found in the payload. Alerts are grouped into three categories:

- **PII Exfiltration** — email addresses, phone numbers, or tracker-specific hashed identity fields (Facebook CAPI, Google Analytics enhanced conversions, TikTok Events API, and others)
- **Location Tracking** — latitude/longitude, GPS coordinates, or address fields (country, city, zip, etc.)
- **Action Tracking** — behavioral fields that describe what the user did: page visits, clicks, scroll position, video playback

### Badge

The extension icon shows a `!` badge when tracking activity is detected on the active tab:
- **Yellow** — third-party tracking cookies are present
- **Orange** — a POST request containing PII or location data was sent to a third-party domain

The badge is cleared when the user opens the relevant tab in the popup.

## Project Structure

[WXT](https://wxt.dev/guide/essentials/project-structure) is used to package the source code into the final extension.

```
src/
├─ entrypoints/
│   ├─ background.ts         # Service worker: intercepts requests, manages badge, answers popup messages
│   ├─ content.ts            # Content script: reserved for future page-level instrumentation
│   │
│   └─ popup/
│       ├─ index.html        # Extension popup shell
│       └─ main.ts           # Popup UI — two-tab layout for Cookies and Requests
│
└─ features/
    └─ cookies/
        ├─ types.ts              # Shared TypeScript interfaces for messages and data structures
        ├─ cookieQuery.ts        # Queries first-party + observed third-party cookies and merges them
        ├─ thirdPartyDomains.ts  # chrome.storage.session store of third-party origins per tab
        └─ securityCookies.ts    # Allowlist of known harmless security/anti-abuse cookies

wxt.config.ts          # Extension manifest & permissions
```

### Data flow

1. **`chrome.webRequest` listeners** in `background.ts` fire on every request:
   - `onBeforeRequest` — captures POST body bytes before the request is sent
   - `onSendHeaders` — analyzes the captured payload: skips auth handshakes and binary formats, then scans for PII/location/action fields; records the request and fires alerts
   - `onCompleted` — records the request's domain as a third-party origin (via `thirdPartyDomains.ts`) if it differs from the initiating page; triggers a debounced badge update

2. **`chrome.tabs.onUpdated`** clears per-tab state on navigation start and re-queries cookies on page load complete.

3. When the **popup opens**, it sends three messages to the background:
   - `GET_COOKIES` → background calls `queryCookiesWithThirdParty` (first-party query + one query per observed third-party origin)
   - `GET_ALERTS` → returns the tab's accumulated alert list
   - `GET_POST_REQUESTS` → returns every third-party POST observed this page load

## Getting Started

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9

### Install as an extension (recommended)

This method allows you to use the extension during normal browsing

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/Speedrunyourknowledge/track-the-tracker.git
   cd track-the-tracker
   npm install
   ```
2. Build the extension:
   ```bash
   npm run build
   ```
3. Open Chrome and go to `chrome://extensions`
4. Enable **Developer mode** (toggle in the top-right corner)
5. Click **Load unpacked** and select the `.output/chrome-mv3/` folder (generated during the build step)

The extension is now installed and behaves identically to a Chrome Web Store install.

> Alternatively, download the pre-built `.zip` from the [latest GitHub Release](../../releases/latest), extract it, and follow steps 3–5 above, pointing to the extracted folder instead.

### Pin the extension

Click the puzzle-piece icon in the toolbar, then pin **Track the Tracker**

### Scripts

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Create a production build
npm run build

# Create a production build and zip it for distribution
npm run zip

# Run linter
npm run lint

# Sync wxt config
# (Only needed if you changed the config)
npm run sync
```

In development mode, WXT will open a Chrome instance with the extension already loaded. Any change to a source file triggers an automatic reload.

## Success Criteria

- ✅ Reads the contents of the browser's cookie jar
- ✅ Identifies third-party tracking cookies and separates them from harmless security cookies
- ✅ Detects outgoing third-party tracking requests
- ✅ Notifies the user when a tracking request contains PII (de-anonymization alert)
- ✅ Detects location data in POST request payloads
- ✅ Detects behavioral action tracking (e.g., clicks, page visits) in POST request payloads
- ✅ Identifies tracker-specific hashed identity fields for major ad platforms

## License

See [LICENSE](LICENSE)
