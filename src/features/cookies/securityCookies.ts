/**
 * Identifies known harmless third-party security/anti-abuse cookies
 * that should not be treated as tracking cookies
 */

import { getDomain } from "tldts";

// Google security/anti-abuse tokens — not behavioral trackers
const GOOGLE_SECURITY_COOKIE_NAMES = new Set([
  "AEC",
  "GOOGLE_ABUSE_EXEMPTION",
  "__Secure-YEC",
  "__Secure-YENID",
  "DV",
  "__Secure-BUCKET",
  "__Secure-STRP",
]);

/**
 * Returns true if the cookie is a known harmless security/anti-abuse token.
 * A false result does not mean the cookie is a tracker — only that it is not
 * on the known-harmless allowlist
 */
export function isSecurityCookie(name: string, domain: string): boolean {
  const cleanDomain = domain.replace(/^\./, "");
  const registered = getDomain(cleanDomain);
  return registered === "google.com" && GOOGLE_SECURITY_COOKIE_NAMES.has(name);
}
