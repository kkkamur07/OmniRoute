/**
 * Wire protocol between the OmniRoute dashboard page and this extension.
 *
 * The dashboard embeds `chrome-extension://<id>/bridge.html` as a hidden iframe and talks to it
 * with window.postMessage only. The bridge frame posts to the dashboard origin (from
 * location.ancestorOrigins / event.origin, never from message data); the dashboard posts to the
 * extension origin.
 *
 *   bridge -> page: {source: SOURCE_EXTENSION, type: MSG_READY, version, approved}
 *   bridge -> page: {source: SOURCE_EXTENSION, type: MSG_APPROVED, version}
 *   page -> bridge: {source: SOURCE_DASHBOARD, type: MSG_ARM, requestId, provider, state, redirectUri}
 *   page -> bridge: {source: SOURCE_DASHBOARD, type: MSG_BRIDGE_STATUS} (asks for a fresh ready)
 *   bridge -> page: {source: SOURCE_EXTENSION, type: MSG_ARMED | MSG_ERROR, requestId, reason?}
 *
 * Inside the extension (chrome.runtime.sendMessage):
 *   bridge -> worker:  {type: MSG_ARM | MSG_BRIDGE_STATUS, origin, ...payload}
 *   approve -> worker: {type: MSG_APPROVE_ORIGIN, origin, isFramed}
 *   worker -> bridges: {type: MSG_ORIGIN_APPROVED, origin}
 *
 * Pure module: no chrome.* or DOM access, so Node tests can import it.
 */

export const SOURCE_EXTENSION = "omniroute-oauth-bridge";
export const SOURCE_DASHBOARD = "omniroute-dashboard";

export const MSG_READY = "ready";
export const MSG_ARM = "oauth-bridge:arm";
export const MSG_ARMED = "oauth-bridge:armed";
export const MSG_ERROR = "oauth-bridge:error";
export const MSG_APPROVED = "approved";
/** Page -> bridge and bridge -> service worker: is this dashboard origin approved? */
export const MSG_BRIDGE_STATUS = "oauth-bridge:status";
/** Approve page -> service worker (chrome.runtime.sendMessage, approve.html only). */
export const MSG_APPROVE_ORIGIN = "approve-origin";
/** Service worker -> bridge frames after an origin was approved. */
export const MSG_ORIGIN_APPROVED = "origin-approved";

/** How long an armed rule lives before it is removed, in minutes. */
export const RULE_TTL_MINUTES = 10;

export const LIMITS = Object.freeze({
  requestId: 128,
  provider: 64,
  state: 512,
  redirectUri: 512,
});

/** Error reasons sent back to the page in MSG_ERROR. */
export const REASONS = Object.freeze({
  invalidMessage: "invalid-message",
  unapprovedOrigin: "unapproved-origin",
  redirectNotAllowed: "redirect-not-allowed",
  internal: "internal-error",
});

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]+$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]*$/;
// Printable ASCII without space; OAuth state values are opaque but URL-safe in practice.
const STATE_RE = /^[\x21-\x7e]+$/;

function isBoundedString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isValidRequestId(value) {
  return isBoundedString(value, LIMITS.requestId) && REQUEST_ID_RE.test(value);
}

export function isValidProvider(value) {
  return isBoundedString(value, LIMITS.provider) && PROVIDER_RE.test(value);
}

export function isValidState(value) {
  return isBoundedString(value, LIMITS.state) && STATE_RE.test(value);
}

/** http(s) absolute URL with no query, fragment or credentials. */
export function isValidRedirectUri(value) {
  if (!isBoundedString(value, LIMITS.redirectUri)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password || url.search || url.hash) return false;
  return value.includes("?") === false && value.includes("#") === false;
}

/** A plain web origin as found in sender.origin / location.origin. */
export function isValidOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin === value;
}

/**
 * Validates a page -> extension arm message.
 * @returns {{ok: true, value: {requestId, provider, state, redirectUri}} | {ok: false, reason: string}}
 */
export function parseArmMessage(data) {
  if (!data || typeof data !== "object") return { ok: false, reason: REASONS.invalidMessage };
  if (data.type !== MSG_ARM) return { ok: false, reason: REASONS.invalidMessage };
  const { requestId, provider, state, redirectUri } = data;
  if (
    !isValidRequestId(requestId) ||
    !isValidProvider(provider) ||
    !isValidState(state) ||
    !isValidRedirectUri(redirectUri)
  ) {
    return { ok: false, reason: REASONS.invalidMessage };
  }
  return { ok: true, value: { requestId, provider, state, redirectUri } };
}

/** True for a window message the bridge frame should forward as an arm request. */
export function isDashboardArmMessage(data) {
  return (
    !!data && typeof data === "object" && data.source === SOURCE_DASHBOARD && data.type === MSG_ARM
  );
}

/** True for a window message asking the bridge frame for a fresh `ready`. */
export function isDashboardStatusMessage(data) {
  return (
    !!data &&
    typeof data === "object" &&
    data.source === SOURCE_DASHBOARD &&
    data.type === MSG_BRIDGE_STATUS
  );
}

export function readyMessage(version, approved = false) {
  return { source: SOURCE_EXTENSION, type: MSG_READY, version, approved: approved === true };
}

export function approvedMessage(version) {
  return { source: SOURCE_EXTENSION, type: MSG_APPROVED, version };
}

export function armedMessage(requestId) {
  return { source: SOURCE_EXTENSION, type: MSG_ARMED, requestId };
}

export function errorMessage(requestId, reason) {
  return { source: SOURCE_EXTENSION, type: MSG_ERROR, requestId, reason };
}
