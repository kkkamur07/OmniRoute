import test from "node:test";
import assert from "node:assert/strict";

import {
  appendedModeFor,
  buildAppendedRegexFilter,
  buildRedirectRule,
  buildRegexFilter,
  escapeRegex,
  isArmableRedirect,
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

const REJECTED = { ok: false, reason: "redirect-not-allowed" };
const armable = (uri: unknown, provider = "codex", dashboardOrigin?: string) =>
  isArmableRedirect(uri as string, provider, undefined, { dashboardOrigin });

test("isArmableRedirect: accepts exact list entries and loopback variants", () => {
  const ok = { ok: true };
  assert.deepEqual(armable("http://localhost:1455/auth/callback"), ok);
  assert.deepEqual(armable("https://platform.claude.com/oauth/code/callback", "claude"), ok);
  assert.deepEqual(armable("http://localhost:20128/callback", "renderhour"), ok);
  assert.deepEqual(armable("http://localhost:1456/auth/callback"), ok);
  assert.deepEqual(armable("http://localhost:1455/oauth/cb"), ok);
  assert.deepEqual(armable("http://localhost/any/path"), ok);
  assert.deepEqual(armable("http://127.0.0.1:4242/new/path"), ok);
  assert.deepEqual(armable("http://127.0.0.1:65535/x"), ok);
  assert.deepEqual(armable("https://platform.claude.com/oauth/code/v2/callback"), ok);
  assert.deepEqual(armable("https://login.microsoftonline.com/other/path", "copilot-m365-web"), ok);
});

test("isArmableRedirect: rejects disallowed redirect URIs", () => {
  const cases: unknown[] = [
    "https://evil.example/callback",
    "http://192.168.1.5:1455/x",
    "http://user:pw@127.0.0.1:1/",
    "http://user@localhost:1455/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    `http://localhost:1455/${"a".repeat(2100)}`,
    "http://localhost:1455/cb#x",
    "http://localhost:1455/cb?a=1",
    "http://[::1]:1455/cb",
    "https://localhost:1455/cb",
    "http://localhost:0/cb",
    "http://localhost:65536/cb",
    undefined,
    null,
    42,
    "not a url",
    "https://platform.claude.com.evil.example/x",
    "http://platform.claude.com/oauth/code/callback",
    "https://platform.claude.com/x?a=1",
    "https://platform.claude.com/x#f",
    "https://user:pw@platform.claude.com/x",
  ];
  for (const c of cases) assert.deepEqual(armable(c), REJECTED, String(c).slice(0, 60));
});

test("isArmableRedirect: rejects the dashboard origin itself", () => {
  assert.deepEqual(
    armable("https://dash.example.com/callback", "codex", "https://dash.example.com"),
    REJECTED
  );
  assert.deepEqual(
    armable("http://localhost:20128/callback", "codex", "http://localhost:20128"),
    REJECTED
  );
  assert.deepEqual(
    armable("http://localhost:20128/callback", "renderhour", "http://localhost:20128"),
    REJECTED
  );
});

const ZED_LIST = [
  {
    provider: "zed-hosted",
    kind: "dashboard-port-loopback",
    redirectUri: "http://127.0.0.1:{port}/",
    stateMode: "appended",
    requiredParams: ["user_id", "access_token"],
  },
  { provider: "codex", kind: "fixed-loopback", redirectUri: REDIRECT },
];
const ZED_URI = "http://127.0.0.1:58443/";
const ZED_PARAMS = ["user_id", "access_token"];

function zedRule(state = "s", redirectUri = ZED_URI) {
  return buildRedirectRule({
    id: 3,
    redirectUri,
    state,
    dashboardOrigin: DASH,
    requiredParams: ZED_PARAMS,
  });
}
const zedMatch = (url: string) => url.match(new RegExp(zedRule().condition.regexFilter));
function zedSubstitute(url: string, state = "s"): string | null {
  const rule = zedRule(state);
  const re = new RegExp(rule.condition.regexFilter);
  if (!re.test(url)) return null;
  // DNR uses \1 for group 1; JS replace uses $1.
  return url.replace(re, rule.action.redirect.regexSubstitution.replace("\\1", "$1"));
}

test("appended: matches both param orders, extra params and a fragment", () => {
  assert.ok(zedMatch(`${ZED_URI}?user_id=1&access_token=abc`));
  assert.ok(zedMatch(`${ZED_URI}?access_token=abc&user_id=1`));
  assert.ok(zedMatch(`${ZED_URI}?x=1&user_id=1&y=2&access_token=abc&z=3`));
  assert.ok(zedMatch(`${ZED_URI}?access_token=abc&x=1&user_id=1#frag`));
  assert.equal(
    zedMatch(`${ZED_URI}?user_id=1&access_token=abc`)?.[1],
    "user_id=1&access_token=abc"
  );
});

test("appended: rejects missing params, look-alikes and other URIs", () => {
  const cases = [
    `${ZED_URI}?user_id=1`,
    `${ZED_URI}?access_token=abc`,
    `${ZED_URI}`,
    `${ZED_URI}?user_idx=1&access_token=abc`,
    `${ZED_URI}?xuser_id=1&access_token=abc`,
    `${ZED_URI}?user_id=1&my_access_token=abc`,
    `${ZED_URI}?user_id&access_token=abc`,
    `${ZED_URI}#?user_id=1&access_token=abc`,
    `${ZED_URI}?x=1#&user_id=1&access_token=abc`,
    "http://127.0.0.1:58444/?user_id=1&access_token=abc",
    "http://127.0.0.1:58443/other?user_id=1&access_token=abc",
    "http://127.0.0.1:584430/?user_id=1&access_token=abc",
    "http://127.0.0.1.evil.example:58443/?user_id=1&access_token=abc",
    "http://evil.example/?u=http://127.0.0.1:58443/?user_id=1&access_token=abc",
    "https://127.0.0.1:58443/?user_id=1&access_token=abc",
    "http://127.0.0.10:58443/?user_id=1&access_token=abc",
  ];
  for (const c of cases) assert.equal(zedMatch(c), null, c);
});

test("appended: substitution puts the encoded state first and drops the fragment", () => {
  const state = "a b/c=d&e";
  assert.equal(
    zedSubstitute(`${ZED_URI}?user_id=1&access_token=abc#frag`, state),
    `${DASH}/callback?state=${encodeURIComponent(state)}&user_id=1&access_token=abc`
  );
  assert.equal(
    zedSubstitute(`${ZED_URI}?access_token=abc&user_id=1`),
    `${DASH}/callback?state=s&access_token=abc&user_id=1`
  );
  assert.ok(zedRule().action.redirect.regexSubstitution.startsWith(`${DASH}/callback?state=s&`));
});

test("appended: a crafted landing state never shadows the armed state", () => {
  for (const landing of [
    `${ZED_URI}?state=evil&user_id=1&access_token=x`,
    `${ZED_URI}?user_id=1&state=evil&access_token=x`,
    `${ZED_URI}?user_id=1&access_token=x&st%61te=evil`,
  ]) {
    const relayed = zedSubstitute(landing, "armed");
    assert.ok(relayed, landing);
    assert.equal(new URL(relayed).searchParams.get("state"), "armed", landing);
  }
});

test("appended: encoded state has no DNR substitution metacharacters", () => {
  const nasty = "\\1\\0$1$&\\\\9%5C";
  const rule = zedRule(nasty);
  const sub = rule.action.redirect.regexSubstitution;
  const head = "/callback?state=";
  const tail = sub.slice(sub.indexOf(head) + head.length, sub.lastIndexOf("&\\1"));
  assert.equal(tail, encodeURIComponent(nasty));
  assert.ok(!tail.includes("\\"));
  assert.equal(sub.match(/\\[0-9]/g)?.length, 1);
});

test("appended: rule shape and RE2 compatibility", () => {
  const rule = zedRule();
  assert.equal(rule.priority, 1);
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame"]);
  assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
  const f = rule.condition.regexFilter;
  for (const bad of ["(?=", "(?!", "(?<"]) assert.ok(!f.includes(bad));
  assert.ok(!/\\[1-9]/.test(f));
  // Exactly one capturing group: every other "(" is "(?:".
  assert.equal((f.match(/\((?!\?)/g) ?? []).length, 1);
});

test("appended: buildAppendedRegexFilter refuses bad requiredParams", () => {
  assert.equal(buildAppendedRegexFilter(ZED_URI, []), null);
  assert.equal(buildAppendedRegexFilter(ZED_URI, ["a", "b", "c", "d"]), null);
  assert.equal(buildAppendedRegexFilter(ZED_URI, ["a=b"]), null);
  assert.equal(buildAppendedRegexFilter(ZED_URI, undefined as unknown as string[]), null);
  assert.ok(buildAppendedRegexFilter(ZED_URI, ["a", "b", "c"]));
  assert.equal(
    buildRedirectRule({
      id: 1,
      redirectUri: ZED_URI,
      state: "s",
      dashboardOrigin: DASH,
      requiredParams: [],
    }),
    null
  );
});

test("appendedModeFor: only built-in appended entries count", () => {
  assert.deepEqual(appendedModeFor("zed-hosted", ZED_LIST), { requiredParams: ZED_PARAMS });
  assert.equal(appendedModeFor("codex", ZED_LIST), null);
  assert.equal(appendedModeFor("codex"), null);
  assert.equal(appendedModeFor("unknown", ZED_LIST), null);
  // Arm-message-like data (no stateMode in the allow-list) never turns appended mode on.
  const arm = { provider: "codex", state: "s", redirectUri: REDIRECT, stateMode: "appended" };
  assert.equal(appendedModeFor(arm.provider, ZED_LIST), null);
  assert.equal(appendedModeFor(arm as unknown as string, ZED_LIST), null);
  const tooMany = [{ ...ZED_LIST[0], requiredParams: ["a", "b", "c", "d"] }];
  assert.equal(appendedModeFor("zed-hosted", tooMany), null);
  assert.equal(appendedModeFor("zed-hosted", [{ ...ZED_LIST[0], requiredParams: [] }]), null);
  assert.equal(appendedModeFor("zed-hosted", [{ ...ZED_LIST[0], stateMode: "query" }]), null);
});

test("isArmableRedirect: appended providers need an exact allow-list match", () => {
  const arm = (uri: string) => isArmableRedirect(uri, "zed-hosted", ZED_LIST);
  assert.deepEqual(arm(ZED_URI), { ok: true });
  assert.deepEqual(arm("http://127.0.0.1:1/"), { ok: true });
  assert.deepEqual(arm("http://127.0.0.1:58443/other"), REJECTED);
  assert.deepEqual(arm("http://localhost:58443/"), REJECTED);
  assert.deepEqual(arm("http://127.0.0.1/"), REJECTED);
});
