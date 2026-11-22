/**
 * OmniRoute OAuth bridge: the hidden frame a dashboard embeds
 * (`<iframe src="chrome-extension://<id>/bridge.html">`).
 *
 * The frame talks to its parent with window.postMessage only. It accepts a message only when
 * it is embedded exactly one level deep (window.parent === window.top and
 * location.ancestorOrigins has one entry), the message comes from window.parent and its
 * browser-authenticated event.origin equals that one ancestor origin. The dashboard origin is
 * therefore never read from message data. Requests are forwarded to the service worker as
 * `{type, origin: event.origin, ...payload}`; replies go back to event.origin only.
 *
 * On load the frame announces `ready` (with whether this origin is approved) to the parent.
 * When the operator approves the origin on approve.html the service worker broadcasts
 * MSG_ORIGIN_APPROVED, and chrome.storage.onChanged fires as well; either one makes the frame
 * post `approved` to the parent, so the dashboard continues without a reload.
 *
 * Code, state and token values are secrets: never log them.
 */

import {
  MSG_ARM,
  MSG_BRIDGE_STATUS,
  MSG_ORIGIN_APPROVED,
  REASONS,
  approvedMessage,
  armedMessage,
  errorMessage,
  isDashboardArmMessage,
  isDashboardStatusMessage,
  isValidOrigin,
  readyMessage,
} from "./protocol.js";

const APPROVED_ORIGINS_KEY = "approvedOrigins";

/**
 * The dashboard origin this frame is embedded in, or null when the frame is top-level, nested
 * more than one level deep, or the ancestor is not a plain http(s) origin.
 * @param {any} win the frame's window
 * @returns {string | null}
 */
export function embeddingOrigin(win) {
  try {
    if (!win || !win.parent || win.parent === win) return null;
    if (win.parent !== win.top) return null;
    const ancestors = win.location?.ancestorOrigins;
    if (!ancestors || ancestors.length !== 1) return null;
    const origin = ancestors[0];
    return isValidOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

/**
 * The origin to act for when `event` is a message from this frame's one-level parent, else
 * null. event.origin must match the single ancestor origin.
 * @param {{ source?: unknown, origin?: string, data?: unknown } | null | undefined} event
 * @param {any} win the frame's window
 */
export function acceptedParentOrigin(event, win) {
  const parentOrigin = embeddingOrigin(win);
  if (!parentOrigin || !event || event.source !== win.parent) return null;
  if (event.origin !== parentOrigin) return null;
  return parentOrigin;
}

/** The service worker request for an accepted arm message (known fields only). */
export function armForward(data, origin) {
  return {
    type: MSG_ARM,
    origin,
    requestId: data?.requestId,
    provider: data?.provider,
    state: data?.state,
    redirectUri: data?.redirectUri,
  };
}

function versionOf(c) {
  try {
    return String(c.runtime.getManifest().version || "");
  } catch {
    return "";
  }
}

async function send(c, message) {
  try {
    return await c.runtime.sendMessage(message);
  } catch {
    // Extension context invalidated (reloaded or updated) or the worker is unavailable.
    return null;
  }
}

/**
 * Wires the frame: announces `ready`, forwards parent requests and reports approval changes.
 * Does nothing (returns null) when the frame is not embedded one level deep in a web origin.
 * @param {any} win the frame's window
 * @param {any} c the chrome namespace
 * @returns {null | { origin: string, stop: () => void, settled: Promise<void> }}
 */
export function startBridge(win, c) {
  const origin = embeddingOrigin(win);
  if (!origin) return null;
  const version = versionOf(c);
  /** null until the first status answer, then whether `origin` is approved. */
  let approved = null;

  const post = (message) => {
    try {
      win.parent.postMessage(message, origin);
    } catch {
      // The parent went away or navigated to another origin.
    }
  };

  const announce = async () => {
    const response = await send(c, { type: MSG_BRIDGE_STATUS, origin });
    approved = !!(response && response.ok === true && response.approved === true);
    post(readyMessage(version, approved));
  };

  const setApproved = (next) => {
    if (approved === null || next === approved) return;
    approved = next;
    post(next ? approvedMessage(version) : readyMessage(version, false));
  };

  const onWindowMessage = (event) => {
    const from = acceptedParentOrigin(event, win);
    if (!from) return;
    const data = event.data;
    if (isDashboardStatusMessage(data)) {
      void announce();
      return;
    }
    if (!isDashboardArmMessage(data)) return;
    const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
    void send(c, armForward(data, from)).then((response) => {
      if (response && response.ok === true) {
        post(armedMessage(requestId));
        return;
      }
      const reason = response && typeof response.reason === "string" ? response.reason : null;
      post(errorMessage(requestId, reason || REASONS.internal));
    });
  };

  const onRuntimeMessage = (message, sender) => {
    if (!sender || sender.id !== c.runtime?.id) return false;
    if (message && message.type === MSG_ORIGIN_APPROVED && message.origin === origin) {
      setApproved(true);
    }
    return false;
  };

  const onStorageChanged = (changes, areaName) => {
    if (areaName !== "local" || !changes || !changes[APPROVED_ORIGINS_KEY]) return;
    const next = changes[APPROVED_ORIGINS_KEY].newValue;
    setApproved(Array.isArray(next) && next.includes(origin));
  };

  win.addEventListener("message", onWindowMessage);
  c.runtime?.onMessage?.addListener(onRuntimeMessage);
  c.storage?.onChanged?.addListener(onStorageChanged);
  const settled = announce();

  return {
    origin,
    settled,
    stop() {
      win.removeEventListener("message", onWindowMessage);
      c.runtime?.onMessage?.removeListener(onRuntimeMessage);
      c.storage?.onChanged?.removeListener(onStorageChanged);
    },
  };
}

if (typeof window !== "undefined" && typeof chrome !== "undefined" && chrome.runtime?.id) {
  startBridge(window, chrome);
}
