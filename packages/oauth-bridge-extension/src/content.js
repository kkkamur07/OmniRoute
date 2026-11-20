/**
 * OmniRoute OAuth bridge: content script for approved dashboard origins.
 *
 * Classic script (registered content scripts cannot be ES modules), so the constants below
 * are inlined. They mirror src/protocol.js; keep both in sync.
 *
 * Announces itself to the page with a "ready" message and forwards the dashboard's
 * "oauth-bridge:arm" request to the service worker, replying with "oauth-bridge:armed" or
 * "oauth-bridge:error". All messages use targetOrigin = location.origin.
 */
(() => {
  if (window.__omnirouteOauthBridgeLoaded) return;
  window.__omnirouteOauthBridgeLoaded = true;

  // Mirrors protocol.js.
  const SOURCE_EXTENSION = "omniroute-oauth-bridge";
  const SOURCE_DASHBOARD = "omniroute-dashboard";
  const MSG_READY = "ready";
  const MSG_ARM = "oauth-bridge:arm";
  const MSG_ARMED = "oauth-bridge:armed";
  const MSG_ERROR = "oauth-bridge:error";
  const REASON_INTERNAL = "internal-error";

  let version = "";
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    version = "";
  }

  if (document.documentElement) {
    document.documentElement.dataset.omnirouteOauthBridge = version;
  }

  function post(message) {
    try {
      window.postMessage(message, location.origin);
    } catch {
      // Opaque origins cannot be targeted; nothing else to do.
    }
  }

  function postReady() {
    if (document.documentElement) {
      document.documentElement.dataset.omnirouteOauthBridge = version;
    }
    post({ source: SOURCE_EXTENSION, type: MSG_READY, version });
  }

  function reply(requestId, response) {
    const base = { source: SOURCE_EXTENSION };
    if (typeof requestId === "string") base.requestId = requestId;
    if (response && response.ok === true) {
      post({ ...base, type: MSG_ARMED });
      return;
    }
    const reason = response && typeof response.reason === "string" ? response.reason : null;
    post({ ...base, type: MSG_ERROR, reason: reason || REASON_INTERNAL });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.source !== SOURCE_DASHBOARD || data.type !== MSG_ARM) return;

    const requestId = data.requestId;
    const forwarded = {
      type: data.type,
      requestId: data.requestId,
      provider: data.provider,
      state: data.state,
      redirectUri: data.redirectUri,
    };
    try {
      Promise.resolve(chrome.runtime.sendMessage(forwarded)).then(
        (response) => reply(requestId, response),
        () => reply(requestId, null)
      );
    } catch {
      // Extension context invalidated (reloaded or updated).
      reply(requestId, null);
    }
  });

  postReady();
  document.addEventListener("DOMContentLoaded", postReady, { once: true });
  window.addEventListener("load", postReady, { once: true });
})();
