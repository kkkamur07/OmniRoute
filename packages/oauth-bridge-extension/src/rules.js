/**
 * Pure helpers for the allow-list check and the declarativeNetRequest redirect rule.
 * No chrome.* access, so Node tests can import it.
 */

import { ALLOWED_REDIRECTS } from "./allowedRedirects.generated.js";

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

/** A declarativeNetRequest session rule redirecting the matched tab to the dashboard. */
export function buildRedirectRule({ id, redirectUri, state, dashboardOrigin }) {
  return {
    id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { regexSubstitution: `${dashboardOrigin}/callback?\\1` },
    },
    condition: {
      regexFilter: buildRegexFilter(redirectUri, state),
      // OAuth state values are case-sensitive; DNR defaults to case-insensitive.
      isUrlFilterCaseSensitive: true,
      resourceTypes: ["main_frame"],
    },
  };
}
