// Popup entry — runs when the user clicks the extension icon.
// Communicates with the background via chrome.runtime.sendMessage or chrome.storage.
const app = document.getElementById("app")!;
app.textContent = "Loading trackers…";

// TODO: query background for collected tracker data for the current tab
// chrome.runtime.sendMessage({ type: "GET_TRACKERS" }, (response) => { ... });
