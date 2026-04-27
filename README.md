# Overview

A Chrome extension that reveals cross-site tracking activity as you browse. It inspects the browser's cookie jar to surface third-party tracking cookies, and intercepts outgoing POST requests to flag when PII, location data, or behavioral signals are sent to third-party domains. Results are shown in a popup with a Cookies tab and a Requests tab. The extension icon displays a `!` badge whenever tracking activity is detected.

## Motivation

Internet users routinely authorize cross-site tracking by clicking "Accept All" on cookie consent banners, often without realizing what they are agreeing to. The result is an **illusion of privacy**: personal data is routinely collected and sold without transparent user consent. This extension acts as an **Auditor**, not an ad-blocker, revealing tracking activity in real time.

### Core Privacy Problems

- **Privacy Debt** — cookies can be used to track your behavior, and this tracking becomes more pervasive over time as more cookies are accumulated
- **De-Anonymization** — outgoing network requests can send Personally Identifiable Information (PII), such as your email, to third-party servers, linking your true identity to your online activity

## Features

### Cookies tab

Shows all cookies associated with the current webpage. Third-party cookies are checked against the Disconnect.me [tracker list](https://github.com/disconnectme/disconnect-tracking-protection), an actively-maintained list of known tracking domains. Cookies whose domain appears in this list are classified as trackers.
> A tracking domain is one which collects user data from multiple websites not owned by the domain itself
<br>

Example of Cookie Detection and Classification
<img width="336" height="485" alt="cookies-tab" src="https://github.com/user-attachments/assets/527bdb97-d5d7-48df-bc2c-992507b3a5f4" />

Third-Party Cookie Subtypes
- **Trackers** — belong to a known tracking domain
- **Unlabeled** — could not be classified
- **Security (Harmless)** — used for anti-abuse (i.e., preventing cyberattacks like spamming or botting)

Each tracking cookie displays a category that indicates its overall purpose. You can view the full list of categories and their descriptions [here](https://disconnect.me/trackerprotection#categories_of_trackers). Two categories are treated as harmless and are displayed with a yellow label instead of orange:

- **Anti-fraud** — used by services that detect and prevent online fraud
- **ConsentManagers** — used to manage cookie consent preferences

Examples of Tracking Cookies
<img width="337" height="538" alt="cookies-tracking" src="https://github.com/user-attachments/assets/9e93a44a-ea6d-4646-88fa-42e970422c8b" />

### Requests tab

Shows all third-party POST requests sent from the current webpage, with field-level highlights for any PII or action-tracking data found in the payload. Alerts are grouped into three categories:

- **PII Exfiltration** — email addresses, phone numbers, or tracker-specific hashed identity fields (e.g., Facebook CAPI, Google Analytics enhanced conversions, TikTok Events API)
- **Location Tracking** — GPS coordinates or precise location fields (e.g., city, zip code)
- **Action Tracking** — behavioral fields that describe what the user did: page visits, clicks, scroll position, video playback

Examples of Privacy Alerts
<img width="342" height="474" alt="tiktok-pii" src="https://github.com/user-attachments/assets/1404013c-3e84-4a87-9496-cdf97a51acdc" />

### Badge

The extension icon shows a `!` badge when tracking activity is detected on the active tab:
- **Yellow** — at least one third-party **tracking** cookie is present
  - Cookies in "harmless" categories do not trigger this badge
- **Orange** — a POST request containing PII or location data was sent to a third-party domain

The badge is cleared when the user opens the popup tab that triggered the badge notification.

**Badge update behavior:**
- The yellow badge fires **once per page load**. After it has been set, additional third-party cookie detections for the same page don't re-trigger it, preventing notification spam
- The orange badge fires **the first time a PII or location alert is detected** and takes priority over the yellow badge
- Both states reset on page navigation

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
├─ data/
│   └─ trackers.json         # disconnect.me tracker list
│
└─ features/
    └─ cookies/
        ├─ types.ts              # Shared TypeScript interfaces for messages and data structures
        ├─ cookieQuery.ts        # Queries first-party + observed third-party cookies and merges them
        ├─ thirdPartyDomains.ts  # chrome.storage.session store of third-party origins per tab
        ├─ securityCookies.ts    # Allowlist of known harmless security/anti-abuse cookies
        └─ trackerLookup.ts      # Builds a lookup table of known tracker domains

wxt.config.ts          # Extension manifest & permissions
```

### Data flow

1. **`chrome.webRequest` listeners** in `background.ts` fire on every request:
   - `onBeforeRequest` — captures POST body bytes before the request is sent
   - `onSendHeaders` — analyzes the captured payload: skips auth handshakes and binary formats, then scans for PII/location/action fields; records the request and fires alerts
   - `onCompleted` — records the request's domain as a third-party origin (via `thirdPartyDomains.ts`) if it differs from the initiating page; triggers a debounced badge update

2. **`chrome.tabs.onUpdated`** clears per-tab state on navigation start and re-queries cookies on page load complete.

3. When the **popup opens**, it sends three messages to the background:
   - `GET_COOKIES` — background calls `queryCookiesWithThirdParty` (first-party query + one query per observed third-party origin)
   - `GET_ALERTS` — returns the tab's accumulated alert list
   - `GET_POST_REQUESTS` — returns every third-party POST observed this page load

## Getting Started

### Install as an extension

By installing the extension, you can use it during normal browsing.

#### Option A — Download the pre-built zip

1. Download the `chrome.zip` from the [latest GitHub Release](https://github.com/Speedrunyourknowledge/track-the-tracker/releases/latest) and extract it
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the folder extracted from the zip

#### Option B — Build from source

Prerequisites
- Node.js ≥ 18
- npm ≥ 9

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

Both options produce an identical install.

### Pin the extension

Click the puzzle-piece icon in the Chrome toolbar, then pin **Track the Tracker**.

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
- ✅ Identifies third-party tracking cookies by referencing a list of known trackers
- ✅ Detects outgoing third-party tracking requests
- ✅ Notifies the user when a tracking request contains PII (de-anonymization alert)
- ✅ Detects location data in POST request payloads
- ✅ Detects behavioral action tracking (e.g., clicks, page visits) in POST request payloads
- ✅ Identifies tracker-specific hashed identity fields for major ad platforms

## License

See [LICENSE](LICENSE)
