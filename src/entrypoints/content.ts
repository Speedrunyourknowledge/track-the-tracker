// Content script — injected into every page.
//
// WHY THE CONTENT SCRIPT?
// chrome.webRequest in the background can intercept outgoing web requests, but it 
// cannot read request bodies. Reading this information requires page-level access.

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    // TODO: Detect the use of Fetch and XMLHttpRequest, notify the service worker 
    // if third-party requests are made. This should be implemented in a way that
    // doesn't flag legitimate third-party authentication requests as tracking.
  },
});
