/**
 * Approving and removing dashboard origins. Shared by the popup (popup.js, Remove) and the
 * service worker (background.js, for the approve page).
 *
 * Approval is only a stored list: the dashboard reaches the extension through the bridge.html
 * frame, so no host permission or content script is needed per dashboard.
 *
 * Every function takes the `chrome` namespace as its first argument so Node tests can pass a mock.
 * Storage key: chrome.storage.local "approvedOrigins" (string[] of origins).
 */

import { isValidOrigin } from "./protocol.js";

export const APPROVED_ORIGINS_KEY = "approvedOrigins";

export async function getApproved(c) {
  const stored = await c.storage.local.get(APPROVED_ORIGINS_KEY);
  const origins = stored?.[APPROVED_ORIGINS_KEY];
  return Array.isArray(origins) ? origins.filter((o) => isValidOrigin(o)) : [];
}

async function saveApproved(c, origins) {
  await c.storage.local.set({ [APPROVED_ORIGINS_KEY]: origins });
}

/**
 * Stores `origin` as approved.
 * @returns {Promise<string[]>} the approved origins after the change
 */
export async function approveOrigin(c, origin) {
  if (!isValidOrigin(origin)) throw new Error("invalid origin");
  const next = Array.from(new Set([...(await getApproved(c)), origin]));
  await saveApproved(c, next);
  return next;
}

/** Drops `origin` from the approved list. */
export async function removeOrigin(c, origin) {
  const next = (await getApproved(c)).filter((o) => o !== origin);
  await saveApproved(c, next);
  return next;
}
