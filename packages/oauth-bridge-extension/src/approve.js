/**
 * Approve page (approve.html?origin=<dashboard origin>), opened by the dashboard with
 * window.open. Shows the origin and one "Allow on <host>" button. The click handler requests
 * the host permission directly (it must run inside the user gesture), then asks the service
 * worker to store the approval and inject the content script into open dashboard tabs.
 */

import { approveOriginFromSearch } from "./origin.js";
import { MSG_APPROVE_ORIGIN } from "./protocol.js";
const CLOSE_DELAY_MS = 1500;

const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind ? `status ${kind}` : "status";
}

function onAllowClick(origin) {
  const button = $("allow");
  button.disabled = true;
  setStatus("");
  // No await before this call: Chrome drops the request outside the click gesture.
  chrome.permissions.request({ origins: [`${origin}/*`] }).then(
    async (granted) => {
      if (!granted) {
        button.disabled = false;
        setStatus("Permission was not granted.", "fail");
        return;
      }
      let response = null;
      try {
        response = await chrome.runtime.sendMessage({ type: MSG_APPROVE_ORIGIN, origin });
      } catch {
        response = null;
      }
      if (!response || response.ok !== true) {
        button.disabled = false;
        setStatus("Could not save the approval. Try again.", "fail");
        return;
      }
      button.hidden = true;
      setStatus("Allowed. You can close this window.", "ok");
      setTimeout(() => window.close(), CLOSE_DELAY_MS);
    },
    () => {
      button.disabled = false;
      setStatus("Permission was not granted.", "fail");
    }
  );
}

function init() {
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
  document.title = `Allow on ${host}`;
}

if (typeof document !== "undefined") init();
