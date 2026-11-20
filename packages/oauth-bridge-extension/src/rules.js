/**
 * Pure helpers for the redirect policy and the declarativeNetRequest redirect rule.
 * No chrome.* access, so Node tests can import it.
 *
 * Redirect policy (isArmableRedirect): a redirect URI can be armed when it is an exact
 * allow-list match for the provider, a plain http loopback URI on 127.0.0.1 or localhost
 * (any port and path, no userinfo/query/fragment), or an https URI on the origin of any
 * allow-listed provider code page (same restrictions). URIs on the dashboard origin, overlong
 * URIs and URIs whose literal text differs from what URL parsing normalizes are rejected.
 */

import { ALLOWED_REDIRECTS } from "./allowedRedirects.generated.js";
import { REASONS } from "./protocol.js";

const PORT_PLACEHOLDER = "{port}";

/** Escapes every RE2/JS regex metacharacter. */
export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templateToRegex(template) {
  const [before, after] = template.split(PORT_PLACEHOLDER);
  if (after === undefined) return null;
  return new RegExp(`^${escapeRegex(before)}[0-9]{1,5}${escapeRegex(after)}$`);
}

/**
 * True only if `redirectUri` equals an allowed entry for `provider`
 * ("{port}" matches any 1-5 digit port). Anything else is rejected.
 */
export function matchAllowedRedirect(redirectUri, provider, allowed = ALLOWED_REDIRECTS) {
  if (typeof redirectUri !== "string" || typeof provider !== "string") return false;
  return allowed.some((entry) => {
    if (entry.provider !== provider) return false;
    if (!entry.redirectUri.includes(PORT_PLACEHOLDER)) return entry.redirectUri === redirectUri;
    const re = templateToRegex(entry.redirectUri);
    return !!re && re.test(redirectUri);
  });
}

const MAX_REDIRECT_URI_LENGTH = 2048;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const DEFAULT_PORTS = { "http:": "80", "https:": "443" };
// Backslashes, whitespace and control characters are normalized away by URL parsing, so the
// literal string (which the DNR regex is built from) would no longer describe the parsed URL.
const UNSAFE_CHARS = /[\\\s\u0000-\u001f\u007f]/;

/**
 * True when the literal scheme and authority of `raw` are exactly what URL parsing produced:
 * lowercase scheme, then the normalized host (or hostname plus the explicit default port).
 */
function literalMatchesParsed(raw, url) {
  const prefix = `${url.protocol}//`;
  if (!raw.startsWith(prefix)) return false;
  const rest = raw.slice(prefix.length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  if (authority === url.host) return true;
  return url.port === "" && authority === `${url.hostname}:${DEFAULT_PORTS[url.protocol]}`;
}

/** No userinfo, no query and no fragment, checked on both the parsed URL and the raw text. */
function isBareUrl(raw, url) {
  if (url.username !== "" || url.password !== "") return false;
  if (url.search !== "" || raw.includes("?")) return false;
  if (url.hash !== "" || raw.includes("#")) return false;
  return true;
}

function isLoopbackRedirect(raw, url) {
  if (url.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  if (url.port !== "") {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return isBareUrl(raw, url);
}

function codePageOrigin(entry) {
  try {
    return new URL(entry.redirectUri).origin;
  } catch {
    return null;
  }
}

function isProviderCodePageRedirect(raw, url, allowed) {
  if (url.protocol !== "https:") return false;
  const onCodePageOrigin = allowed.some(
    (entry) => entry && entry.kind === "provider-code-page" && codePageOrigin(entry) === url.origin
  );
  return onCodePageOrigin && isBareUrl(raw, url);
}

const MAX_REQUIRED_PARAMS = 3;
// Unreserved URL characters only, so a param name never needs percent-encoding.
const PARAM_NAME_RE = /^[A-Za-z0-9._~-]{1,64}$/;

/**
 * Appended state mode for `provider`, read only from the built-in allow-list: returns
 * `{requiredParams}` when an entry for the provider has `stateMode: "appended"` and 1-3 valid,
 * distinct `requiredParams`; otherwise null (the default "query" mode, state carried as `state=`).
 */
export function appendedModeFor(provider, allowed = ALLOWED_REDIRECTS) {
  if (typeof provider !== "string" || !Array.isArray(allowed)) return null;
  const entry = allowed.find((e) => e && e.provider === provider && e.stateMode === "appended");
  if (!entry) return null;
  const params = entry.requiredParams;
  if (!Array.isArray(params) || params.length === 0 || params.length > MAX_REQUIRED_PARAMS) {
    return null;
  }
  if (!params.every((p) => typeof p === "string" && PARAM_NAME_RE.test(p))) return null;
  if (new Set(params).size !== params.length) return null;
  return { requiredParams: [...params] };
}

/**
 * Decides whether `redirectUri` may be armed for `provider`. Accepts an exact allow-list
 * match, a bare http loopback URI (127.0.0.1 or localhost, any port and path), or a bare https
 * URI on the origin of any allow-listed provider code page. Always rejects non-strings,
 * URIs over 2048 characters, unparsable or non-literal URIs, and URIs on `dashboardOrigin`.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function isArmableRedirect(
  redirectUri,
  provider,
  allowed = ALLOWED_REDIRECTS,
  { dashboardOrigin } = {}
) {
  const reject = { ok: false, reason: REASONS.redirectNotAllowed };
  if (typeof redirectUri !== "string" || typeof provider !== "string") return reject;
  if (redirectUri.length > MAX_REDIRECT_URI_LENGTH) return reject;
  if (UNSAFE_CHARS.test(redirectUri)) return reject;
  let url;
  try {
    url = new URL(redirectUri);
  } catch {
    return reject;
  }
  if (typeof dashboardOrigin === "string" && url.origin === dashboardOrigin) return reject;
  if (!literalMatchesParsed(redirectUri, url)) return reject;

  if (matchAllowedRedirect(redirectUri, provider, allowed)) return { ok: true };
  // Appended-mode providers carry no state of their own: only the exact allow-listed URI.
  if (appendedModeFor(provider, allowed)) return reject;
  if (isLoopbackRedirect(redirectUri, url)) return { ok: true };
  if (isProviderCodePageRedirect(redirectUri, url, allowed)) return { ok: true };
  return reject;
}

/**
 * The regexFilter for one armed sign-in: exact redirect URI (origin + path), then a
 * query in which `state=<encoded state>` is a whole parameter. Group 1 captures the
 * full query so the substitution keeps it. RE2-compatible (no lookaround/backrefs).
 */
export function buildRegexFilter(redirectUri, state) {
  const encodedState = encodeURIComponent(state);
  return (
    `^${escapeRegex(redirectUri)}\\?` +
    `((?:[^#]*&)?state=${escapeRegex(encodedState)}(?:&[^#]*)?)` +
    `(?:#.*)?$`
  );
}

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
  );
}

/**
 * The regexFilter for an appended-mode sign-in: exact redirect URI, then a query in which every
 * name in `requiredParams` is a whole parameter (`name=value`, preceded by the query start or
 * `&`), in any order, with any other params around them. Group 1 captures the full query; every
 * inner group is non-capturing. RE2-compatible: the "any order" is an alternation over the
 * permutations (at most 3! = 6), no lookaround/backrefs. Returns null for an invalid list.
 */
export function buildAppendedRegexFilter(redirectUri, requiredParams) {
  if (!Array.isArray(requiredParams) || requiredParams.length === 0) return null;
  if (requiredParams.length > MAX_REQUIRED_PARAMS) return null;
  if (!requiredParams.every((p) => typeof p === "string" && PARAM_NAME_RE.test(p))) return null;
  const alternatives = permutations(requiredParams).map(
    (order) =>
      order.map((name) => `(?:[^#]*&)?${escapeRegex(name)}=[^&#]*`).join("&") + "(?:&[^#]*)?"
  );
  return `^${escapeRegex(redirectUri)}\\?((?:${alternatives.join("|")}))(?:#.*)?$`;
}

/**
 * A declarativeNetRequest session rule redirecting the matched tab to the dashboard. With
 * `requiredParams` (appended mode) the rule matches buildAppendedRegexFilter and the
 * substitution puts `state=<encoded state>` FIRST, before the captured query, so
 * URLSearchParams.get("state") (first value wins) always yields the armed state even when a
 * crafted landing query carries its own `state=`. The filter does not try to exclude such a
 * param: an RE2 prefix-complement in every gap of every permutation would multiply the pattern
 * against Chrome's 2 KB DNR regex memory cap, and URLSearchParams decodes names, so
 * `st%61te=` would slip past it anyway. encodeURIComponent never emits `\`, so the state
 * cannot be read as a `\N` capture reference. Returns null if the appended filter cannot be
 * built.
 */
export function buildRedirectRule({ id, redirectUri, state, dashboardOrigin, requiredParams }) {
  const appended = requiredParams !== undefined;
  const regexFilter = appended
    ? buildAppendedRegexFilter(redirectUri, requiredParams)
    : buildRegexFilter(redirectUri, state);
  if (!regexFilter) return null;
  const regexSubstitution = appended
    ? `${dashboardOrigin}/callback?state=${encodeURIComponent(state)}&\\1`
    : `${dashboardOrigin}/callback?\\1`;
  return {
    id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { regexSubstitution },
    },
    condition: {
      regexFilter,
      // OAuth state values are case-sensitive; DNR defaults to case-insensitive.
      isUrlFilterCaseSensitive: true,
      resourceTypes: ["main_frame"],
    },
  };
}
