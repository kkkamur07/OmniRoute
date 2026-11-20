/**
 * Approving and removing dashboard origins. Shared by the popup (popup.js) and the service
 * worker (background.js, for the approve page), so both register the content script the same way.
 *
 * Every function takes the `chrome` namespace as its first argument so Node tests can pass a mock.
 * Storage key: chrome.storage.local "approvedOrigins" (string[] of origins).
 */

import { isValidOrigin } from "./protocol.js";
import { tabOrigin } from "./origin.js";

export const APPROVED_ORIGINS_KEY = "approvedOrigins";
export const CONTENT_SCRIPT_ID = "omniroute-oauth-bridge";
export const CONTENT_SCRIPT_FILE = "src/content.js";

export async function getApproved(c) {
  const stored = await c.storage.local.get(APPROVED_ORIGINS_KEY);
  const origins = stored?.[APPROVED_ORIGINS_KEY];
  return Array.isArray(origins) ? origins.filter((o) => isValidOrigin(o)) : [];
}

async function saveApproved(c, origins) {
  await c.storage.local.set({ [APPROVED_ORIGINS_KEY]: origins });
}

/** Re-registers the content script for exactly `origins` (unregisters it when empty). */
export async function registerContentScript(c, origins) {
  const existing = await c.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  if (existing.length > 0) {
    await c.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  }
  if (origins.length === 0) return;
  await c.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      js: [CONTENT_SCRIPT_FILE],
      matches: origins.map((o) => `${o}/*`),
      runAt: "document_start",
      persistAcrossSessions: true,
    },
  ]);
}

/**
 * Injects content.js into every open top-level tab of `origin`, so an already open dashboard
 * receives the "ready" message without a reload. content.js ignores a second injection.
 * @returns {Promise<number>} how many tabs were injected
 */
export async function injectIntoOpenTabs(c, origin) {
  let tabs = [];
  try {
    tabs = await c.tabs.query({ url: `${origin}/*` });
  } catch {
    return 0;
  }
  let count = 0;
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (typeof tab?.id !== "number" || tabOrigin(tab) !== origin) continue;
    try {
      await c.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT_FILE] });
      count++;
    } catch {
      // The tab may be unreachable (discarded, error page); the registered script covers reloads.
    }
  }
  return count;
}

/**
 * Stores `origin` as approved, registers the content script for all approved origins and
 * injects it into open tabs of `origin`. The caller must already hold the host permission
 * (chrome.permissions.request runs in the click handler of the popup or approve page).
 * @returns {Promise<string[]>} the approved origins after the change
 */
export async function approveOrigin(c, origin) {
  if (!isValidOrigin(origin)) throw new Error("invalid origin");
  const next = Array.from(new Set([...(await getApproved(c)), origin]));
  await saveApproved(c, next);
  await registerContentScript(c, next);
  await injectIntoOpenTabs(c, origin);
  return next;
}

/** Drops `origin` from the approved list, its host permission and the content script matches. */
export async function removeOrigin(c, origin) {
  try {
    await c.permissions.remove({ origins: [`${origin}/*`] });
  } catch {
    // Required host permissions cannot be removed; still drop the approval.
  }
  const next = (await getApproved(c)).filter((o) => o !== origin);
  await saveApproved(c, next);
  await registerContentScript(c, next);
  return next;
}
