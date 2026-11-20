import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRedirectRule,
  buildRegexFilter,
  escapeRegex,
  matchAllowedRedirect,
} from "../../../../packages/oauth-bridge-extension/src/rules.js";

const REDIRECT = "http://localhost:1455/auth/callback";
const DASH = "http://localhost:20128";

function ruleFor(state: string, redirectUri = REDIRECT) {
  return buildRedirectRule({ id: 7, redirectUri, state, dashboardOrigin: DASH });
}

function match(url: string, state: string, redirectUri = REDIRECT): RegExpMatchArray | null {
  const rule = ruleFor(state, redirectUri);
  return url.match(new RegExp(rule.condition.regexFilter));
}

function substitute(url: string, state: string, redirectUri = REDIRECT): string | null {
  const rule = ruleFor(state, redirectUri);
  const m = url.match(new RegExp(rule.condition.regexFilter));
  if (!m) return null;
  return rule.action.redirect.regexSubstitution.replace("\\1", m[1]);
}

test("matches state in first, last and middle position, with fragment", () => {
  assert.ok(match(`${REDIRECT}?state=s&code=c`, "s"));
  assert.ok(match(`${REDIRECT}?code=c&state=s`, "s"));
  assert.ok(match(`${REDIRECT}?code=c&state=s&x=1`, "s"));
  assert.ok(match(`${REDIRECT}?code=c&state=s#frag`, "s"));
  assert.ok(match(`${REDIRECT}?state=s`, "s"));
});

test("rejects non-matching states and look-alike params", () => {
  assert.equal(match(`${REDIRECT}?code=c&state=other`, "s"), null);
  assert.equal(match(`${REDIRECT}?code=c`, "s"), null);
  assert.equal(match(`${REDIRECT}?xstate=s&code=c`, "s"), null);
  assert.equal(match(`${REDIRECT}?code=c&mystate=s`, "s"), null);
  assert.equal(match(`${REDIRECT}?state=s2&code=c`, "s"), null);
  assert.equal(match(`${REDIRECT}?code=c&state=s2`, "s"), null);
});

test("rejects other path, port, host, scheme and missing query", () => {
  assert.equal(match("http://localhost:1455/other?state=s", "s"), null);
  assert.equal(match("http://localhost:1456/auth/callback?state=s", "s"), null);
  assert.equal(match("http://example.com:1455/auth/callback?state=s", "s"), null);
  assert.equal(match("https://localhost:1455/auth/callback?state=s", "s"), null);
  assert.equal(match(REDIRECT, "s"), null);
  assert.equal(match(`${REDIRECT}/extra?state=s`, "s"), null);
});

test("substitution keeps the full query and drops the fragment", () => {
  assert.equal(
    substitute(`${REDIRECT}?code=abc&state=s&extra=1#frag`, "s"),
    `${DASH}/callback?code=abc&state=s&extra=1`
  );
  assert.equal(
    substitute(`${REDIRECT}?state=s&code=z&a=b`, "s"),
    `${DASH}/callback?state=s&code=z&a=b`
  );
});

test("rule shape", () => {
  const rule = ruleFor("s");
  assert.equal(rule.id, 7);
  assert.equal(rule.priority, 1);
  assert.equal(rule.action.type, "redirect");
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame"]);
  assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
  assert.equal(rule.action.redirect.regexSubstitution, `${DASH}/callback?\\1`);
  assert.doesNotThrow(() => new RegExp(rule.condition.regexFilter));
});

test("special characters in state are matched literally", () => {
  const state = "a.b*c(d)+[e]$^|?";
  const enc = encodeURIComponent(state);
  assert.ok(match(`${REDIRECT}?code=c&state=${enc}`, state));
  assert.equal(match(`${REDIRECT}?code=c&state=aXb*c(d)+[e]$^|?`, state), null);
  assert.equal(match(`${REDIRECT}?state=aXb`, "a.b"), null);
  assert.ok(match(`${REDIRECT}?state=a.b`, "a.b"));
});

test("state with encodeURIComponent chars is matched in encoded form", () => {
  const state = "a b/c=d";
  assert.ok(match(`${REDIRECT}?state=${encodeURIComponent(state)}&code=1`, state));
  assert.equal(match(`${REDIRECT}?state=a b/c=d`, state), null);
});

test("regexFilter avoids lookaround and backreferences (RE2 compatible)", () => {
  const filter = buildRegexFilter(REDIRECT, "s.t*");
  assert.ok(!filter.includes("(?="));
  assert.ok(!filter.includes("(?!"));
  assert.ok(!filter.includes("(?<"));
  assert.ok(!/\\[1-9]/.test(filter));
  assert.equal(escapeRegex("a.b"), "a\\.b");
});

const FIXTURE = [
  {
    provider: "p-fixed",
    kind: "fixed-loopback",
    redirectUri: "http://localhost:1455/auth/callback",
  },
  {
    provider: "p-port",
    kind: "dashboard-port-loopback",
    redirectUri: "http://localhost:{port}/auth/callback",
  },
  { provider: "p-https", kind: "external", redirectUri: "https://example.com/cb" },
];

test("matchAllowedRedirect: exact and provider mismatch", () => {
  assert.equal(
    matchAllowedRedirect("http://localhost:1455/auth/callback", "p-fixed", FIXTURE),
    true
  );
  assert.equal(matchAllowedRedirect("https://example.com/cb", "p-https", FIXTURE), true);
  assert.equal(
    matchAllowedRedirect("http://localhost:1455/auth/callback", "p-https", FIXTURE),
    false
  );
  assert.equal(matchAllowedRedirect("http://localhost:1455/auth/callback", "nope", FIXTURE), false);
  assert.equal(
    matchAllowedRedirect("http://localhost:1456/auth/callback", "p-fixed", FIXTURE),
    false
  );
});

test("matchAllowedRedirect: {port} placeholder", () => {
  const ok = (u: string) => matchAllowedRedirect(u, "p-port", FIXTURE);
  assert.equal(ok("http://localhost:1/auth/callback"), true);
  assert.equal(ok("http://localhost:20128/auth/callback"), true);
  assert.equal(ok("http://localhost:65535/auth/callback"), true);
  assert.equal(ok("http://localhost:123456/auth/callback"), false);
  assert.equal(ok("http://localhost:/auth/callback"), false);
  assert.equal(ok("http://localhost:abc/auth/callback"), false);
  assert.equal(ok("http://localhost:20128/auth/callback/x"), false);
  assert.equal(ok("http://localhost:20128/auth/callback?a=1"), false);
  assert.equal(ok("https://localhost:20128/auth/callback"), false);
});

test("matchAllowedRedirect: non-string input", () => {
  assert.equal(matchAllowedRedirect(undefined as unknown as string, "p-fixed", FIXTURE), false);
  assert.equal(matchAllowedRedirect(null as unknown as string, "p-fixed", FIXTURE), false);
  assert.equal(matchAllowedRedirect(123 as unknown as string, "p-fixed", FIXTURE), false);
  assert.equal(
    matchAllowedRedirect("http://localhost:1455/auth/callback", 5 as unknown as string, FIXTURE),
    false
  );
});

test("matchAllowedRedirect: default list", () => {
  assert.equal(matchAllowedRedirect("http://localhost:1455/auth/callback", "codex"), true);
  assert.equal(matchAllowedRedirect("http://localhost:1456/auth/callback", "codex"), false);
  assert.equal(matchAllowedRedirect("http://localhost:20128/callback", "renderhour"), true);
  assert.equal(matchAllowedRedirect("http://localhost:1234567/callback", "renderhour"), false);
  assert.equal(
    matchAllowedRedirect("https://platform.claude.com/oauth/code/callback", "claude"),
    true
  );
  assert.equal(matchAllowedRedirect("http://localhost:1455/auth/callback", "antigravity"), false);
  assert.equal(matchAllowedRedirect("http://localhost:51121/oauth-callback", "antigravity"), false);
});
