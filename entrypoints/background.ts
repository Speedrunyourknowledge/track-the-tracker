// Service worker — runs persistently in the background.
// Access to chrome.webRequest and chrome.cookies lives here.
export default defineBackground(() => {
  console.log("Track the Tracker background started.");

  // TODO: listen for web requests to identify third-party origins
  // chrome.webRequest.onCompleted.addListener(...)

  // TODO: query cookies for the active tab
  // chrome.cookies.getAll(...)
});
