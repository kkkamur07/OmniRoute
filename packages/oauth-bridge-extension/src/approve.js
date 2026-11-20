/**
 * Approve page (approve.html?origin=<dashboard origin>), opened by the dashboard with
 * window.open. Shows the origin and one "Allow on <host>" button. The click asks the service
 * worker to store the approval; no Chrome permission prompt is involved. The worker then tells
 * the dashboard's bridge frame and closes this tab about a second later.
 *
 * Clickjacking defenses: the page refuses to render the button when framed (isFramed; the
 * worker also rejects a message that reports isFramed or does not come from a top-level tab),
 * and the button stays disabled for ENABLE_DELAY_MS after it appears so a click aimed at a decoy
 * cannot land on it.
 */

import { approveOriginFromSearch } from "./origin.js";
import { MSG_APPROVE_ORIGIN } from "./protocol.js";

/** Fallback close if the worker could not close the tab (it normally does after ~1 s). */
const FALLBACK_CLOSE_DELAY_MS = 3000;
export const ENABLE_DELAY_MS = 500;

/**
 * True when `win` is not the top-level window. A cross-origin parent can make the comparison
 * throw; that counts as framed.
 * @param {{ top?: unknown, self?: unknown } | null | undefined} win
 */
export function isFramed(win) {
  try {
    if (!win) return true;
    return win.top !== win.self;
  } catch {
    return true;
  }
}

/**
 * Disables `button` now and enables it after `delayMs`, using `setTimer` (setTimeout).
 * @returns the timer handle
 */
export function enableAfterDelay(button, delayMs = ENABLE_DELAY_MS, setTimer = setTimeout) {
  button.disabled = true;
  return setTimer(() => {
    button.disabled = false;
  }, delayMs);
}

const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind ? `status ${kind}` : "status";
}

async function onAllowClick(origin) {
  const button = $("allow");
  button.disabled = true;
  setStatus("");
  let response = null;
  try {
    response = await chrome.runtime.sendMessage({
      type: MSG_APPROVE_ORIGIN,
      origin,
      isFramed: isFramed(window),
    });
  } catch {
    response = null;
  }
  if (!response || response.ok !== true) {
    button.disabled = false;
    setStatus("Could not save the approval. Try again.", "fail");
    return;
  }
  button.hidden = true;
  setStatus("Allowed. This window closes by itself.", "ok");
  setTimeout(() => window.close(), FALLBACK_CLOSE_DELAY_MS);
}

function init() {
  if (isFramed(window)) {
    $("invalid").textContent =
      "This page cannot be used inside another site. Open it from your OmniRoute dashboard.";
    $("invalid").hidden = false;
    return;
  }
  const origin = approveOriginFromSearch(location.search);
  if (!origin) {
    $("invalid").hidden = false;
    return;
  }
  const host = new URL(origin).host;
  $("origin").textContent = origin;
  $("allow").textContent = `Allow on ${host}`;
  $("allow").addEventListener("click", () => onAllowClick(origin));
  $("ask").hidden = false;
  enableAfterDelay($("allow"));
  document.title = `Allow on ${host}`;
}

if (typeof document !== "undefined") init();
