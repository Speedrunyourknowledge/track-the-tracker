/**
 * Content script injected into every page.
 * POST request body interception is handled in background.ts, not here
 */

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    // Reserved for future page-level instrumentation
  },
});
