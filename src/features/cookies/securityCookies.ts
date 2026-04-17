/**
 * Identifies known harmless third-party security/anti-abuse cookies that
 * should not be treated as tracking cookies.
 *
 * Currently covers Google's abuse-exemption cookies (AEC, __Secure-YEC,
 * __Secure-YENID), which are security tokens used to prevent fraud and bot
 * traffic — not behavioral trackers
 */

import { getDomain } from "tldts";

/**
 * Cookie names that Google uses as security/anti-abuse tokens.
 * These appear as third-party cookies on any site embedding Google services
 * (YouTube, Maps, Sign-in, Ads), but carry no tracking intent.
 *
 * AEC / GOOGLE_ABUSE_EXEMPTION — abuse-exemption tokens that prevent bots from
 *   acting on your behalf (fraud, spam, invalid ad clicks).
 * __Secure-YEC / __Secure-YENID — YouTube-specific anti-abuse variants.
 * DV — device-verification token used to confirm legitimate device identity.
 * __Secure-BUCKET — server-side routing/load-balancing assignment (infrastructure).
 * __Secure-STRP — session security strip token
 */
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
