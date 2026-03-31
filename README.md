# Track the Tracker

## Motivation

Most users unknowingly authorize cross-site tracking by clicking "Accept All" on cookie banners. The result is an **Illusion of Privacy**: personal data is routinely collected and sold without transparent user consent. This extension acts as an **Auditor** — not an ad-blocker — revealing tracking activity in real time.

### Core Privacy Problems

- **Privacy Debt** — cookies can be used to track your behavior, and this tracking becomes more pervasive over time as more cookies are accumulated
- **De-Anonymization** — outgoing network requests can send Personally Identifiable Information (PII), such as your email, to third-party servers, linking your true identity to your online activity

## Features

[Screenshots will go here]

## Project Structure

```
entrypoints/
├─ background.ts        # Service worker: event listeners
├─ content.ts           # Content script: reads page-level data
│
└─ popup/
    ├─ index.html       # Extension popup window
    └─ main.ts          # Popup logic & UI rendering

wxt.config.ts           # Extension manifest & permissions
```

## Getting Started

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9

### Scripts

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Create a production build and zip it for distribution
npm run zip

# Run linter
npm run lint
```

In development mode, WXT will build the extension and open a Chrome instance with the extension already loaded. Any change to a source file triggers an automatic reload.

### Load Manually in Chrome

1. Run `npm run dev` or `npm run zip`
2. Navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `.output/chrome-mv3/` directory

## Success Criteria

- [x] Reads the contents of the browser's cookie jar
- [x] Detects outgoing third-party tracking requests
- [x] Notifies the user when a tracking request contains PII (de-anonymization alert)

## License

See [LICENSE](LICENSE)
