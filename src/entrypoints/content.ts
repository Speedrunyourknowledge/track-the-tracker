// Content script — injected into every page.
//
// NOTE: chrome.webRequest.onBeforeRequest in the background service worker
// can read POST request bodies (via the "requestBody" extraInfoSpec) for most
// fetch/XHR calls, including JSON payloads in the raw bytes field. Body
// interception is therefore handled in background.ts rather than here.

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    // Reserved for future page-level instrumentation.
  },
});
