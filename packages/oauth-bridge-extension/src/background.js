/**
 * OmniRoute OAuth bridge: service worker.
 *
 * The dashboard (through its hidden bridge.html frame, see bridge.js) arms the extension for ONE
 * sign-in. For that sign-in a
 * declarativeNetRequest session rule redirects the provider's final redirect (a URI accepted by
 * isArmableRedirect in rules.js: an exact allow-list match, a bare http loopback URI on
 * 127.0.0.1 or localhost, or a bare https URI on an allow-listed provider code page origin,
 * never the dashboard origin itself, carrying `state=<armed state>`) to `<dashboard-origin>/callback`,
 * keeping the original query.
 *
 * Appended state mode: for a provider whose built-in allow-list entry has
 * `stateMode: "appended"` (appendedModeFor in rules.js; Zed, whose redirect carries no state),
 * the redirect URI must be an exact allow-list match and the rule instead matches
 * `<redirectUri>?<query with every requiredParam>`, substituting
 * `<dashboard-origin>/callback?state=<armed state>&<query>` (state first, so it wins). Because such a rule cannot tell two
 * attempts apart, arming one replaces every other appended-mode rule for the same provider.
 *
 * When the tab commits that /callback URL the rule is removed and,
 * if the navigation came from our redirect, the tab is closed a few seconds later.
 *
 * Storage keys:
 *   chrome.storage.local   "approvedOrigins"  string[] of approved dashboard origins. Written by
 *                                             approveOrigin in approval.js for the approve page
 *                                             and by removeOrigin from the popup.
 *   chrome.storage.session "armed"            {[ruleId]: ArmedEntry}, kept in session storage
 *                                             because the service worker is restarted often.
 * Alarms: "oauth-bridge-rule-<ruleId>", one per armed rule, fired after RULE_TTL_MINUTES.
 *
 * ArmedEntry: {ruleId, provider, state, redirectUri, dashboardOrigin, tabId, expiresAt,
 *              stateMode: "query" | "appended", requiredParams?, redirectedTabId?}
 *
 * Code, state and token values are secrets: never log them.
 */

import {
  MSG_APPROVE_ORIGIN,
  MSG_ARM,
  MSG_BRIDGE_STATUS,
  MSG_ORIGIN_APPROVED,
  REASONS,
  RULE_TTL_MINUTES,
  isValidOrigin,
  parseArmMessage,
} from "./protocol.js";
import { approveOrigin, getApproved } from "./approval.js";
import { approveOriginFromSearch } from "./origin.js";
import { ALLOWED_REDIRECTS } from "./allowedRedirects.generated.js";
import { appendedModeFor, buildRedirectRule, isArmableRedirect } from "./rules.js";

const ARMED_KEY = "armed";
const ALARM_PREFIX = "oauth-bridge-rule-";
const CLOSE_TAB_DELAY_MS = 3000;
/** How long the approve page shows "Allowed" before the worker closes its tab. */
export const APPROVE_CLOSE_DELAY_MS = 1000;
const REDIRECT_QUALIFIERS = ["server_redirect", "client_redirect"];

function api() {
  return globalThis.chrome;
}

/** The extension version from the manifest, read at call time. */
export function getVersion() {
  return api().runtime.getManifest().version;
}

// Serializes every read-modify-write of the armed map / session rules inside this worker.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function readArmed() {
  const stored = await api().storage.session.get(ARMED_KEY);
  const armed = stored?.[ARMED_KEY];
  return armed && typeof armed === "object" ? armed : {};
}

async function writeArmed(armed) {
  await api().storage.session.set({ [ARMED_KEY]: armed });
}

function readApprovedOrigins() {
  return getApproved(api());
}

function alarmName(ruleId) {
  return `${ALARM_PREFIX}${ruleId}`;
}

function fail(reason) {
  return { ok: false, reason };
}

/** Removes one armed rule, its alarm and its armed entry. Caller holds the queue. */
async function disarm(ruleId) {
  const id = Number(ruleId);
  await api().declarativeNetRequest.updateSessionRules({ addRules: [], removeRuleIds: [id] });
  await api().alarms.clear(alarmName(id));
  const armed = await readArmed();
  if (armed[id] !== undefined) {
    delete armed[id];
    await writeArmed(armed);
  }
}

/** The parsed URL of `sender` when it is a page of this extension at `/<page>`, else null. */
function extensionPageUrl(sender, page) {
  const c = api();
  if (!sender || sender.id !== c.runtime.id || typeof sender.url !== "string") return null;
  let url;
  let base;
  try {
    url = new URL(sender.url);
    base = new URL(c.runtime.getURL(""));
  } catch {
    return null;
  }
  // Compare scheme and host: URL.origin is "null" for non-special schemes in some runtimes.
  if (url.protocol !== base.protocol || url.host !== base.host || !base.host) return null;
  if (url.pathname !== `/${page}`) return null;
  return url;
}

/**
 * True when `sender` is this extension's bridge.html embedded as a frame in a tab (never a
 * top-level page, a content script or another extension).
 */
export function isBridgeFrameSender(sender) {
  if (!extensionPageUrl(sender, "bridge.html")) return false;
  return typeof sender.frameId === "number" && sender.frameId > 0;
}

/**
 * True when `sender` is this extension's approve.html loaded as the top-level page of a tab.
 * Returns the origin named in its `?origin=` query, or null.
 */
export function approvePageOrigin(sender) {
  const url = extensionPageUrl(sender, "approve.html");
  if (!url) return null;
  if (sender.frameId !== 0 || typeof sender.tab?.id !== "number") return null;
  return approveOriginFromSearch(url.search);
}

/**
 * Handles an arm request from a bridge frame. The sender must be bridge.html (isBridgeFrameSender);
 * the dashboard origin is `message.origin`, which bridge.js takes from the browser-authenticated
 * event.origin of its parent, and must be in "approvedOrigins"; the payload is validated with
 * parseArmMessage and the redirect URI must pass isArmableRedirect. On success one
 * session redirect rule is added (replacing any rule already armed for the same state and, in
 * appended mode, every appended-mode rule armed for the same provider), its metadata is stored
 * under "armed" and a TTL alarm is created. `options.allowed` overrides the built-in allow-list
 * (tests only; the message listener never passes it).
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function handleArm(message, sender, { allowed = ALLOWED_REDIRECTS } = {}) {
  try {
    if (!isBridgeFrameSender(sender)) return fail(REASONS.unapprovedOrigin);
    const dashboardOrigin = message?.origin;
    if (!isValidOrigin(dashboardOrigin)) return fail(REASONS.unapprovedOrigin);
    const approved = await readApprovedOrigins();
    if (!approved.includes(dashboardOrigin)) return fail(REASONS.unapprovedOrigin);

    const parsed = parseArmMessage(message);
    if (!parsed.ok) return fail(parsed.reason);
    const { provider, state, redirectUri } = parsed.value;
    const redirectCheck = isArmableRedirect(redirectUri, provider, allowed, { dashboardOrigin });
    if (!redirectCheck.ok) return fail(redirectCheck.reason);
    const appended = appendedModeFor(provider, allowed);

    return await serialized(async () => {
      const dnr = api().declarativeNetRequest;
      const existing = await dnr.getSessionRules();
      const armed = await readArmed();
      const maxArmedId = Object.keys(armed).reduce((max, k) => Math.max(max, Number(k) || 0), 0);
      const maxRuleId = existing.reduce((max, r) => Math.max(max, r.id), 0);
      const ruleId = Math.max(maxArmedId, maxRuleId) + 1;

      const replacedIds = Object.values(armed)
        .filter(
          (entry) =>
            entry &&
            (entry.state === state ||
              (appended && entry.stateMode === "appended" && entry.provider === provider))
        )
        .map((entry) => Number(entry.ruleId));

      const rule = buildRedirectRule({
        id: ruleId,
        redirectUri,
        state,
        dashboardOrigin,
        ...(appended ? { requiredParams: appended.requiredParams } : {}),
      });
      if (!rule) return fail(REASONS.redirectNotAllowed);
      await dnr.updateSessionRules({ addRules: [rule], removeRuleIds: replacedIds });

      for (const oldId of replacedIds) {
        delete armed[oldId];
        await api().alarms.clear(alarmName(oldId));
      }
      armed[ruleId] = {
        ruleId,
        provider,
        state,
        redirectUri,
        dashboardOrigin,
        tabId: sender.tab?.id,
        expiresAt: Date.now() + RULE_TTL_MINUTES * 60 * 1000,
        stateMode: appended ? "appended" : "query",
        ...(appended ? { requiredParams: appended.requiredParams } : {}),
      };
      await writeArmed(armed);
      await api().alarms.create(alarmName(ruleId), { delayInMinutes: RULE_TTL_MINUTES });
      return { ok: true };
    });
  } catch {
    return fail(REASONS.internal);
  }
}

function searchParamsOf(url) {
  try {
    return new URL(url).searchParams;
  } catch {
    return null;
  }
}

/** True when `details.url` is the armed redirect for `entry` (state or required params). */
function isArmedRedirectNavigation(entry, url, params) {
  if (!entry || !url.startsWith(`${entry.redirectUri}?`) || !params) return false;
  if (entry.stateMode === "appended") {
    const required = Array.isArray(entry.requiredParams) ? entry.requiredParams : [];
    return required.length > 0 && required.every((name) => params.has(name));
  }
  return params.get("state") === entry.state;
}

/**
 * webNavigation.onBeforeNavigate (top frame only). When a tab starts navigating to an armed
 * redirect URI (`<redirectUri>?...` with the armed state, or in appended mode with every
 * required param, e.g. a provider code page doing a client-side navigation), records that tab
 * as `redirectedTabId` on the armed entry.
 */
export async function handleBeforeNavigate(details) {
  if (!details || details.frameId !== 0 || typeof details.url !== "string") return;
  try {
    await serialized(async () => {
      const armed = await readArmed();
      const params = searchParamsOf(details.url);
      let changed = false;
      for (const entry of Object.values(armed)) {
        if (!isArmedRedirectNavigation(entry, details.url, params)) continue;
        entry.redirectedTabId = details.tabId;
        changed = true;
      }
      if (changed) await writeArmed(armed);
    });
  } catch {
    // Best effort; the server_redirect qualifier still identifies our redirect.
  }
}

/** The dashboard /callback URL for an armed redirect `url`, mirroring the DNR substitution. */
export function dashboardCallbackUrl(entry, url) {
  const q = url.indexOf("?");
  if (q < 0) return null;
  const hash = url.indexOf("#", q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  if (!query) return null;
  return entry.stateMode === "appended"
    ? `${entry.dashboardOrigin}/callback?state=${encodeURIComponent(entry.state)}&${query}`
    : `${entry.dashboardOrigin}/callback?${query}`;
}

/**
 * Fallback for redirects the DNR rule never sees: a provider code page reached by a client-side
 * route change (webNavigation.onHistoryStateUpdated) or a navigation a page service worker
 * answers (webNavigation.onCommitted). When the top frame of a tab is on an armed redirect URI
 * (same match as the rule: the armed state, or every required param in appended mode), the tab
 * is sent to the dashboard's /callback with the same query. The armed entry records the tab, so
 * handleCommitted disarms the rule and closes the tab as usual.
 */
export async function handleArmedPageLanding(details) {
  if (!details || details.frameId !== 0 || typeof details.url !== "string") return;
  if (typeof details.tabId !== "number" || details.tabId < 0) return;
  try {
    const target = await serialized(async () => {
      const armed = await readArmed();
      const params = searchParamsOf(details.url);
      const entry = Object.values(armed).find((e) =>
        isArmedRedirectNavigation(e, details.url, params)
      );
      if (!entry) return null;
      const next = dashboardCallbackUrl(entry, details.url);
      if (!next) return null;
      entry.redirectedTabId = details.tabId;
      await writeArmed(armed);
      return next;
    });
    if (target) await api().tabs.update(details.tabId, { url: target });
  } catch {
    // Best effort; the paste flow in the dashboard still works.
  }
}

/**
 * webNavigation.onCommitted (top frame only). When a tab commits
 * `<dashboardOrigin>/callback?...state=<armed state>`, the matching rule, alarm and armed entry
 * are removed. The tab is closed after 3 seconds only if the navigation was ours: the tab was
 * seen heading to the armed redirect URI, or the commit came through a redirect (a DNR redirect
 * inside a server redirect chain never fires onBeforeNavigate for the loopback URL).
 */
export async function handleCommitted(details) {
  if (!details || details.frameId !== 0 || typeof details.url !== "string") return;
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }
  if (url.pathname !== "/callback") return;
  const state = url.searchParams.get("state");
  if (!state) return;
  try {
    const shouldClose = await serialized(async () => {
      const armed = await readArmed();
      const match = Object.values(armed).find(
        (entry) => entry && entry.dashboardOrigin === url.origin && entry.state === state
      );
      if (!match) return false;
      await disarm(match.ruleId);
      const qualifiers = Array.isArray(details.transitionQualifiers)
        ? details.transitionQualifiers
        : [];
      return (
        match.redirectedTabId === details.tabId ||
        qualifiers.some((q) => REDIRECT_QUALIFIERS.includes(q))
      );
    });
    if (shouldClose && typeof details.tabId === "number" && details.tabId >= 0) {
      setTimeout(() => {
        Promise.resolve(api().tabs.remove(details.tabId)).catch(() => {});
      }, CLOSE_TAB_DELAY_MS);
    }
  } catch {
    // Nothing to report back to; the TTL alarm still removes the rule.
  }
}

/** chrome.alarms.onAlarm. For "oauth-bridge-rule-<ruleId>" alarms, removes that rule and entry. */
export async function handleAlarm(alarm) {
  const name = alarm?.name;
  if (typeof name !== "string" || !name.startsWith(ALARM_PREFIX)) return;
  const ruleId = Number(name.slice(ALARM_PREFIX.length));
  if (!Number.isInteger(ruleId) || ruleId < 1) return;
  try {
    await serialized(() => disarm(ruleId));
  } catch {
    // The session rule dies with the browser session anyway.
  }
}

/**
 * Removes every session rule, empties the "armed" map and clears all "oauth-bridge-rule-*"
 * alarms. Only called from onStartup / onInstalled, never on a plain worker wake, so live
 * armed sign-ins survive service worker restarts.
 */
export async function clearStaleRules() {
  await serialized(async () => {
    const rules = await api().declarativeNetRequest.getSessionRules();
    if (rules.length > 0) {
      await api().declarativeNetRequest.updateSessionRules({
        addRules: [],
        removeRuleIds: rules.map((r) => r.id),
      });
    }
    await writeArmed({});
    const alarms = await api().alarms.getAll();
    for (const alarm of alarms) {
      if (alarm.name.startsWith(ALARM_PREFIX)) await api().alarms.clear(alarm.name);
    }
  });
}

/**
 * Handles {type: "oauth-bridge:status", origin} from a bridge frame.
 * @returns {Promise<{ok: true, approved: boolean, version: string} | {ok: false, reason: string}>}
 */
export async function handleBridgeStatus(message, sender) {
  try {
    if (!isBridgeFrameSender(sender)) return fail(REASONS.unapprovedOrigin);
    const origin = message?.origin;
    if (message?.type !== MSG_BRIDGE_STATUS || !isValidOrigin(origin)) {
      return fail(REASONS.invalidMessage);
    }
    const approved = (await readApprovedOrigins()).includes(origin);
    return { ok: true, approved, version: getVersion() };
  } catch {
    return fail(REASONS.internal);
  }
}

/** Tells every bridge frame that `origin` is approved. Best effort: none may be open. */
export async function broadcastApproved(origin) {
  try {
    await api().runtime.sendMessage({ type: MSG_ORIGIN_APPROVED, origin });
  } catch {
    // "Receiving end does not exist": no bridge frame is open. storage.onChanged covers the rest.
  }
}

/**
 * Handles {type: "approve-origin", origin, isFramed: false} from the approve page. The sender
 * must be approve.html as the top-level page of a tab, opened for exactly this origin
 * (approvePageOrigin), and the page must report it is not framed. On success the origin is
 * stored, bridge frames are told, and the approve tab is closed after APPROVE_CLOSE_DELAY_MS
 * (the page shows "Allowed" meanwhile; window.close is not reliable for this window).
 * `options.setTimer` replaces setTimeout (tests only).
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function handleApproveOrigin(message, sender, { setTimer = setTimeout } = {}) {
  try {
    const pageOrigin = approvePageOrigin(sender);
    if (!pageOrigin) return fail(REASONS.unapprovedOrigin);
    const origin = message?.origin;
    if (message?.type !== MSG_APPROVE_ORIGIN || !isValidOrigin(origin)) {
      return fail(REASONS.invalidMessage);
    }
    if (message.isFramed !== false || origin !== pageOrigin) return fail(REASONS.unapprovedOrigin);
    await approveOrigin(api(), origin);
    await broadcastApproved(origin);
    const tabId = sender.tab.id;
    setTimer(() => {
      Promise.resolve(api().tabs.remove(tabId)).catch(() => {});
    }, APPROVE_CLOSE_DELAY_MS);
    return { ok: true };
  } catch {
    return fail(REASONS.internal);
  }
}

async function onBrowserStartOrInstall() {
  try {
    await clearStaleRules();
  } catch {
    // Session rules die with the browser session anyway.
  }
}

function respond(promise, sendResponse) {
  promise.then(sendResponse, () => sendResponse(fail(REASONS.internal)));
  return true;
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  const c = api();
  c.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || sender?.id !== c.runtime.id) return false;
    if (message.type === MSG_APPROVE_ORIGIN) {
      return respond(handleApproveOrigin(message, sender), sendResponse);
    }
    if (message.type === MSG_BRIDGE_STATUS) {
      return respond(handleBridgeStatus(message, sender), sendResponse);
    }
    if (message.type === MSG_ARM) return respond(handleArm(message, sender), sendResponse);
    return false;
  });
  c.webNavigation?.onBeforeNavigate.addListener((details) => {
    handleBeforeNavigate(details);
  });
  c.webNavigation?.onCommitted.addListener((details) => {
    handleCommitted(details);
    handleArmedPageLanding(details);
  });
  c.webNavigation?.onHistoryStateUpdated.addListener((details) => {
    handleArmedPageLanding(details);
  });
  c.alarms?.onAlarm.addListener((alarm) => {
    handleAlarm(alarm);
  });
  c.runtime.onStartup?.addListener(() => {
    onBrowserStartOrInstall();
  });
  c.runtime.onInstalled?.addListener(() => {
    onBrowserStartOrInstall();
  });
}
