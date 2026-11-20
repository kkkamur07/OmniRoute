/**
 * OmniRoute OAuth bridge: service worker.
 *
 * The dashboard (through content.js) arms the extension for ONE sign-in. For that sign-in a
 * declarativeNetRequest session rule redirects the provider's final redirect (a URI accepted by
 * isArmableRedirect in rules.js: an exact allow-list match, a bare http loopback URI on
 * 127.0.0.1 or localhost, or a bare https URI on an allow-listed provider code page origin,
 * never the dashboard origin itself, carrying `state=<armed state>`) to `<dashboard-origin>/callback`,
 * keeping the original query. When the tab commits that /callback URL the rule is removed and,
 * if the navigation came from our redirect, the tab is closed a few seconds later.
 *
 * Storage keys:
 *   chrome.storage.local   "approvedOrigins"  string[] of approved dashboard origins. Written by
 *                                             the popup, which also registers content.js.
 *   chrome.storage.session "armed"            {[ruleId]: ArmedEntry}, kept in session storage
 *                                             because the service worker is restarted often.
 * Alarms: "oauth-bridge-rule-<ruleId>", one per armed rule, fired after RULE_TTL_MINUTES.
 *
 * ArmedEntry: {ruleId, state, redirectUri, dashboardOrigin, tabId, expiresAt, redirectedTabId?}
 *
 * Code and state values are secrets: never log them.
 */

import { MSG_ARM, REASONS, RULE_TTL_MINUTES, isValidOrigin, parseArmMessage } from "./protocol.js";
import { buildRedirectRule, isArmableRedirect } from "./rules.js";

const APPROVED_ORIGINS_KEY = "approvedOrigins";
const ARMED_KEY = "armed";
const ALARM_PREFIX = "oauth-bridge-rule-";
const CONTENT_SCRIPT_ID = "omniroute-oauth-bridge";
const CONTENT_SCRIPT_FILE = "src/content.js";
const CLOSE_TAB_DELAY_MS = 3000;
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

async function readApprovedOrigins() {
  const stored = await api().storage.local.get(APPROVED_ORIGINS_KEY);
  const origins = stored?.[APPROVED_ORIGINS_KEY];
  return Array.isArray(origins) ? origins.filter((o) => isValidOrigin(o)) : [];
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

/**
 * Handles an arm request from content.js. The dashboard origin is taken only from
 * `sender.origin` and must be in "approvedOrigins"; the payload is validated with
 * parseArmMessage and the redirect URI must pass isArmableRedirect. On success one
 * session redirect rule is added (replacing any rule already armed for the same state), its
 * metadata is stored under "armed" and a TTL alarm is created.
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function handleArm(message, sender) {
  try {
    const dashboardOrigin = sender?.origin;
    if (!isValidOrigin(dashboardOrigin)) return fail(REASONS.unapprovedOrigin);
    const approved = await readApprovedOrigins();
    if (!approved.includes(dashboardOrigin)) return fail(REASONS.unapprovedOrigin);

    const parsed = parseArmMessage(message);
    if (!parsed.ok) return fail(parsed.reason);
    const { provider, state, redirectUri } = parsed.value;
    const redirectCheck = isArmableRedirect(redirectUri, provider, undefined, { dashboardOrigin });
    if (!redirectCheck.ok) return fail(redirectCheck.reason);

    return await serialized(async () => {
      const dnr = api().declarativeNetRequest;
      const existing = await dnr.getSessionRules();
      const armed = await readArmed();
      const maxArmedId = Object.keys(armed).reduce((max, k) => Math.max(max, Number(k) || 0), 0);
      const maxRuleId = existing.reduce((max, r) => Math.max(max, r.id), 0);
      const ruleId = Math.max(maxArmedId, maxRuleId) + 1;

      const replacedIds = Object.values(armed)
        .filter((entry) => entry && entry.state === state)
        .map((entry) => Number(entry.ruleId));

      const rule = buildRedirectRule({ id: ruleId, redirectUri, state, dashboardOrigin });
      await dnr.updateSessionRules({ addRules: [rule], removeRuleIds: replacedIds });

      for (const oldId of replacedIds) {
        delete armed[oldId];
        await api().alarms.clear(alarmName(oldId));
      }
      armed[ruleId] = {
        ruleId,
        state,
        redirectUri,
        dashboardOrigin,
        tabId: sender.tab?.id,
        expiresAt: Date.now() + RULE_TTL_MINUTES * 60 * 1000,
      };
      await writeArmed(armed);
      await api().alarms.create(alarmName(ruleId), { delayInMinutes: RULE_TTL_MINUTES });
      return { ok: true };
    });
  } catch {
    return fail(REASONS.internal);
  }
}

function stateParam(url) {
  try {
    return new URL(url).searchParams.get("state");
  } catch {
    return null;
  }
}

/**
 * webNavigation.onBeforeNavigate (top frame only). When a tab starts navigating to an armed
 * redirect URI (`<redirectUri>?...` with the armed state, e.g. a provider code page doing a
 * client-side navigation), records that tab as `redirectedTabId` on the armed entry.
 */
export async function handleBeforeNavigate(details) {
  if (!details || details.frameId !== 0 || typeof details.url !== "string") return;
  try {
    await serialized(async () => {
      const armed = await readArmed();
      const state = stateParam(details.url);
      let changed = false;
      for (const entry of Object.values(armed)) {
        if (!entry || !details.url.startsWith(`${entry.redirectUri}?`)) continue;
        if (state !== entry.state) continue;
        entry.redirectedTabId = details.tabId;
        changed = true;
      }
      if (changed) await writeArmed(armed);
    });
  } catch {
    // Best effort; the server_redirect qualifier still identifies our redirect.
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
 * Registers (or updates) the "omniroute-oauth-bridge" content script for the approved origins
 * that still have a granted host permission, at document_start, persisted across sessions.
 * Unregisters it when no origin qualifies.
 */
export async function syncContentScripts() {
  const c = api();
  const approved = await readApprovedOrigins();
  const granted = [];
  for (const origin of approved) {
    if (await c.permissions.contains({ origins: [`${origin}/*`] })) granted.push(origin);
  }
  const existing = await c.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  const isRegistered = existing.some((s) => s.id === CONTENT_SCRIPT_ID);

  if (granted.length === 0) {
    if (isRegistered) await c.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    return;
  }
  const script = {
    id: CONTENT_SCRIPT_ID,
    matches: granted.map((o) => `${o}/*`),
    js: [CONTENT_SCRIPT_FILE],
    runAt: "document_start",
    persistAcrossSessions: true,
  };
  if (isRegistered) await c.scripting.updateContentScripts([script]);
  else await c.scripting.registerContentScripts([script]);
}

async function onBrowserStartOrInstall() {
  try {
    await clearStaleRules();
  } catch {
    // Continue so content scripts are still synced.
  }
  try {
    await syncContentScripts();
  } catch {
    // The popup re-syncs when the operator approves an origin.
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  const c = api();
  c.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== MSG_ARM) return false;
    if (sender?.id !== c.runtime.id) return false;
    handleArm(message, sender).then(sendResponse, () => sendResponse(fail(REASONS.internal)));
    return true;
  });
  c.webNavigation?.onBeforeNavigate.addListener((details) => {
    handleBeforeNavigate(details);
  });
  c.webNavigation?.onCommitted.addListener((details) => {
    handleCommitted(details);
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
