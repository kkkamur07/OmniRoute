import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BRIDGE_ENABLED_PHASES,
  CALLBACK_RELAY_MAX_AGE_MS,
  isBridgeSupportedProvider,
  isTrueLocalhostHost,
  relayForState,
  relayedParam,
  shouldShowBridgeHint,
  shouldUseBridge,
  storedRelayForState,
} from "../../src/shared/components/oauthModal/useOAuthBridge";
import {
  buildRedirectRule,
  buildRegexFilter,
  matchAllowedRedirect,
} from "../../packages/oauth-bridge-extension/src/rules.js";

const STATE = "siwc.aHR0cHM6Ly9kYXNoLmV4YW1wbGUuY29t.Abc-_123";
const M365_STATE = "A".repeat(20) + "b-_".repeat(7) + "Z1";
const CHATGPT_URI = "http://127.0.0.1:1455/auth/callback";
const M365_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";

test("isTrueLocalhostHost", () => {
  assert.equal(isTrueLocalhostHost("localhost"), true);
  assert.equal(isTrueLocalhostHost("127.0.0.1"), true);
  assert.equal(isTrueLocalhostHost("dash.example.com"), false);
  assert.equal(isTrueLocalhostHost(undefined), false);
});

test("relayForState matches only the same state and normalizes fields", () => {
  const relay = relayForState(
    { code: "abc", state: "s1", error: 5, fullUrl: "https://x/callback?code=abc" },
    "s1"
  );
  assert.deepEqual(relay, {
    code: "abc",
    state: "s1",
    error: null,
    fullUrl: "https://x/callback?code=abc",
  });
  assert.equal(relayForState({ code: "abc", state: "other" }, "s1"), null);
  assert.equal(relayForState(null, "s1"), null);
  assert.equal(relayForState("str", "s1"), null);
  assert.equal(relayForState({ state: "s1" }, ""), null);
  assert.equal(relayForState({ state: "s1" }, null), null);
  const odd = relayForState({ code: 1, state: "s1", fullUrl: 7 }, "s1");
  assert.deepEqual(odd, { code: null, state: "s1", error: null, fullUrl: undefined });
});

test("storedRelayForState honours freshness, bad JSON and null", () => {
  const now = 1_000_000;
  const fresh = JSON.stringify({ code: "c", state: "s", timestamp: now - 1000 });
  const stale = JSON.stringify({
    code: "c",
    state: "s",
    timestamp: now - CALLBACK_RELAY_MAX_AGE_MS - 1,
  });
  assert.equal(storedRelayForState(fresh, "s", now)?.code, "c");
  assert.equal(storedRelayForState(stale, "s", now), null);
  assert.equal(storedRelayForState(fresh, "other", now), null);
  assert.equal(storedRelayForState("{not json", "s", now), null);
  assert.equal(storedRelayForState(null, "s", now), null);
});

test("relayedParam reads query params from the relayed url", () => {
  const url = "https://dash.example.com/callback?code=abc&state=siwc.x.y&client_id=oaiapp_123";
  assert.equal(relayedParam(url, "client_id"), "oaiapp_123");
  assert.equal(relayedParam(url, "missing"), undefined);
  assert.equal(relayedParam("not a url", "client_id"), undefined);
  assert.equal(relayedParam(undefined, "client_id"), undefined);
});

test("phase gate and bridge decisions", () => {
  assert.deepEqual([...BRIDGE_ENABLED_PHASES], ["major", "later"]);
  for (const provider of ["chatgpt", "copilot-m365-web"]) {
    assert.equal(isBridgeSupportedProvider(provider), true);
    assert.equal(
      shouldUseBridge({ provider, isTrueLocalhost: false, bridgeVersion: "1.0.0" }),
      true
    );
    assert.equal(
      shouldUseBridge({ provider, isTrueLocalhost: true, bridgeVersion: "1.0.0" }),
      false
    );
    assert.equal(shouldUseBridge({ provider, isTrueLocalhost: false, bridgeVersion: null }), false);
    assert.equal(
      shouldShowBridgeHint({ provider, isTrueLocalhost: false, bridgeVersion: null }),
      true
    );
  }
  assert.equal(isBridgeSupportedProvider("antigravity"), false);
});

test("M365 relay rebuild yields a nativeclient URL with one code and the state", () => {
  const rebuilt = `${M365_URI}?` + new URLSearchParams({ code: "0.AXo", state: M365_STATE });
  const url = new URL(rebuilt);
  assert.equal(`${url.origin}${url.pathname}`, M365_URI);
  assert.deepEqual(url.searchParams.getAll("code"), ["0.AXo"]);
  assert.deepEqual(url.searchParams.getAll("state"), [M365_STATE]);
});

test("matchAllowedRedirect accepts registered pairs and rejects mismatches", () => {
  assert.equal(matchAllowedRedirect(CHATGPT_URI, "chatgpt"), true);
  assert.equal(matchAllowedRedirect(M365_URI, "copilot-m365-web"), true);
  assert.equal(matchAllowedRedirect(M365_URI, "chatgpt"), false);
  assert.equal(matchAllowedRedirect(CHATGPT_URI, "copilot-m365-web"), false);
  assert.equal(matchAllowedRedirect("http://127.0.0.1:1455/other", "chatgpt"), false);
  assert.equal(matchAllowedRedirect("https://evil.example/auth/callback", "chatgpt"), false);
});

test("buildRegexFilter matches the landing URLs for the armed state only", () => {
  const chatgpt = new RegExp(buildRegexFilter(CHATGPT_URI, STATE));
  assert.match(`${CHATGPT_URI}?code=ac_x&scope=openid&state=${STATE}&client_id=oaiapp_1`, chatgpt);
  assert.doesNotMatch(`${CHATGPT_URI}?code=ac_x&state=siwc.other.state`, chatgpt);
  assert.doesNotMatch(`http://127.0.0.1:1455/auth/other?code=a&state=${STATE}`, chatgpt);
  assert.doesNotMatch(`http://localhost:1455/auth/callback?code=a&state=${STATE}`, chatgpt);

  assert.equal(M365_STATE.length, 43);
  const m365 = new RegExp(buildRegexFilter(M365_URI, M365_STATE));
  assert.match(`${M365_URI}?code=0.AXo&state=${M365_STATE}&session_state=abc`, m365);
  assert.doesNotMatch(`${M365_URI}?code=0.AXo&state=${"B".repeat(43)}`, m365);
  assert.doesNotMatch(`https://login.microsoftonline.com/other?code=0&state=${M365_STATE}`, m365);
  assert.doesNotMatch(
    `https://evil.example.com/common/oauth2/nativeclient?state=${M365_STATE}`,
    m365
  );
});

test("redirect rule substitution targets the dashboard /callback", () => {
  const rule = buildRedirectRule({
    id: 1,
    redirectUri: CHATGPT_URI,
    state: STATE,
    dashboardOrigin: "https://dash.example.com",
  });
  assert.equal(rule.action.redirect.regexSubstitution, "https://dash.example.com/callback?\\1");
  assert.equal(rule.condition.regexFilter, buildRegexFilter(CHATGPT_URI, STATE));
});
