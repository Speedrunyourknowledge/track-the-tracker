// Content script — injected into every page.
// Can read document.cookie and page-level info that the background can't see directly.
export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    console.log("Track the Tracker content script loaded on", window.location.hostname);
    // TODO: observe DOM mutations, read first-party cookies, send to background
  },
});
