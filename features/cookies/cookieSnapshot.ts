/**
 * cookieSnapshot.ts
 *
 * Implements a "before/after" diff so the popup can show EXACTLY which cookies
 * were newly set since the page loaded — making it easy to see what an
 * "Allow cookies" banner click actually wrote into your browser.
 *
 * HOW IT WORKS:
 *
 *  1. SNAPSHOT  — Every time a tab finishes loading a new page, the background
 *                 calls storeSnapshot(). This records the cookies that existed
 *                 AT PAGE LOAD for that tab, stored in chrome.storage.session.
 *
 *  2. DIFF      — When the popup opens, it calls diffWithSnapshot() with the
 *                 CURRENT cookies. We compare them to the snapshot and return:
 *                   • newCookies     — cookies absent from the snapshot (brand new)
 *                   • changedCookies — cookies present in the snapshot but with a
 *                                      different value (e.g. rotated session token)
 *
 * WHY chrome.storage.session?
 *   • Session storage is cleared when Chrome shuts down — no stale data persists.
 *   • It's tab-scoped by key (we key by tabId), so multiple open tabs don't
 *     interfere with each other.
 *   • It's accessible from both the background service worker and the popup.
 *
 * LIMITATION:
 *   If the tab was open before the extension installed/restarted, there is no
 *   snapshot for it. diffWithSnapshot() returns nulls in that case and the
 *   popup shows a notice instead of the diff.
 */

import type { CookieInfo } from "./types";

// Storage key format: "snapshot_<tabId>"
const KEY_PREFIX = "snapshot_";

/** Shape of what we persist in chrome.storage.session per tab. */
interface SnapshotRecord {
  cookies: CookieInfo[];
  takenAt: string; // ISO timestamp
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Persists the given cookies as the baseline for a tab.
 * Should be called once per navigation (when the tab status becomes "complete").
 *
 * Overwrites any previous snapshot for this tab — we only care about the
 * snapshot relative to the CURRENT page load, not earlier pages in the session.
 */
export async function storeSnapshot(tabId: number, cookies: CookieInfo[]): Promise<void> {
  const record: SnapshotRecord = {
    cookies,
    takenAt: new Date().toISOString(),
  };
  await chrome.storage.session.set({ [`${KEY_PREFIX}${tabId}`]: record });
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface SnapshotDiff {
  /** Cookies that did NOT exist at page load — the ones you want to see clearly. */
  newCookies: CookieInfo[];
  /** Cookies whose value changed since page load (e.g. session token rotation). */
  changedCookies: CookieInfo[];
  /** When the snapshot was taken — null if no snapshot exists for this tab. */
  snapshotTakenAt: string | null;
}

/**
 * Compares the current cookies for a tab against the stored page-load snapshot.
 *
 * A cookie is identified by the composite key "name@domain" — both fields
 * together uniquely identify a cookie in the browser's jar.
 *
 * Returns empty arrays (not an error) when no snapshot exists, so callers
 * can always destructure the result safely.
 */
export async function diffWithSnapshot(
  tabId: number,
  currentCookies: CookieInfo[],
): Promise<SnapshotDiff> {
  // Retrieve the stored snapshot for this tab from session storage.
  const stored = await chrome.storage.session.get(`${KEY_PREFIX}${tabId}`);
  const record: SnapshotRecord | undefined = stored[`${KEY_PREFIX}${tabId}`];

  // No snapshot means the tab was open before the extension started.
  // We can't compute a meaningful diff, so we surface that to the popup.
  if (!record) {
    return { newCookies: [], changedCookies: [], snapshotTakenAt: null };
  }

  // Build a fast lookup: "name@domain" → cookie value at page load.
  const snapshotMap = new Map<string, string>(
    record.cookies.map((c) => [`${c.name}@${c.domain}`, c.value]),
  );

  const newCookies: CookieInfo[] = [];
  const changedCookies: CookieInfo[] = [];

  for (const cookie of currentCookies) {
    const key = `${cookie.name}@${cookie.domain}`;
    if (!snapshotMap.has(key)) {
      // Cookie is completely new — wasn't in the jar when the page loaded.
      newCookies.push(cookie);
    }
 else if (snapshotMap.get(key) !== cookie.value) {
      // Cookie existed but its value was updated since page load.
      changedCookies.push(cookie);
    }
    // If key exists and value is the same, the cookie is "pre-existing" —
    // it stays in the main `cookies` list but is NOT flagged as new/changed.
  }

  return { newCookies, changedCookies, snapshotTakenAt: record.takenAt };
}

/**
 * Removes the snapshot for a tab.
 * Should be called when a tab is closed, to avoid unbounded storage growth.
 */
export async function clearSnapshot(tabId: number): Promise<void> {
  await chrome.storage.session.remove(`${KEY_PREFIX}${tabId}`);
}
