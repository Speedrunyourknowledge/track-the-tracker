import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  extensionApi: "chrome",
  manifest: {
    name: "Track the Tracker",
    description: "Detects third-party cookies and tracking on websites you visit.",
    version: "1.0.0",
    permissions: ["cookies", "webRequest", "storage", "tabs"],
    host_permissions: ["<all_urls>"],
  },
});
