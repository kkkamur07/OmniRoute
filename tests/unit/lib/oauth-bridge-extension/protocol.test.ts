import test from "node:test";
import assert from "node:assert/strict";

import {
  LIMITS,
  MSG_APPROVED,
  MSG_APPROVE_ORIGIN,
  MSG_ARM,
  MSG_ARMED,
  MSG_BRIDGE_STATUS,
  MSG_ERROR,
  MSG_ORIGIN_APPROVED,
  MSG_READY,
  REASONS,
  RULE_TTL_MINUTES,
  SOURCE_DASHBOARD,
  SOURCE_EXTENSION,
  approvedMessage,
  armedMessage,
  errorMessage,
  isDashboardArmMessage,
  isDashboardStatusMessage,
  isValidOrigin,
  isValidProvider,
  isValidRedirectUri,
  isValidRequestId,
  isValidState,
  parseArmMessage,
  readyMessage,
} from "../../../../packages/oauth-bridge-extension/src/protocol.js";

const nonStrings: unknown[] = [undefined, null, 1, true, {}, [], ["a"]];

test("wire constants", () => {
  assert.equal(SOURCE_EXTENSION, "omniroute-oauth-bridge");
  assert.equal(SOURCE_DASHBOARD, "omniroute-dashboard");
  assert.equal(MSG_READY, "ready");
  assert.equal(MSG_ARM, "oauth-bridge:arm");
  assert.equal(MSG_ARMED, "oauth-bridge:armed");
  assert.equal(MSG_ERROR, "oauth-bridge:error");
  assert.equal(MSG_APPROVED, "approved");
  assert.equal(MSG_BRIDGE_STATUS, "oauth-bridge:status");
  assert.equal(MSG_APPROVE_ORIGIN, "approve-origin");
  assert.equal(MSG_ORIGIN_APPROVED, "origin-approved");
  assert.equal(RULE_TTL_MINUTES, 10);
});

test("isValidRequestId", () => {
  assert.equal(isValidRequestId("abc-123_X.y:z"), true);
  assert.equal(isValidRequestId("a".repeat(LIMITS.requestId)), true);
  assert.equal(isValidRequestId("a".repeat(LIMITS.requestId + 1)), false);
  assert.equal(isValidRequestId(""), false);
  assert.equal(isValidRequestId("has space"), false);
  assert.equal(isValidRequestId("a/b"), false);
  for (const v of nonStrings) assert.equal(isValidRequestId(v), false);
});

test("isValidProvider", () => {
  assert.equal(isValidProvider("codex"), true);
  assert.equal(isValidProvider("devin-cli"), true);
  assert.equal(isValidProvider("a".repeat(LIMITS.provider)), true);
  assert.equal(isValidProvider("a".repeat(LIMITS.provider + 1)), false);
  assert.equal(isValidProvider(""), false);
  assert.equal(isValidProvider("Codex"), false);
  assert.equal(isValidProvider("-codex"), false);
  assert.equal(isValidProvider("co dex"), false);
  for (const v of nonStrings) assert.equal(isValidProvider(v), false);
});

test("isValidState", () => {
  assert.equal(isValidState("abcDEF123-_.~"), true);
  assert.equal(isValidState("a".repeat(LIMITS.state)), true);
  assert.equal(isValidState("a".repeat(LIMITS.state + 1)), false);
  assert.equal(isValidState(""), false);
  assert.equal(isValidState("has space"), false);
  assert.equal(isValidState("tab\there"), false);
  assert.equal(isValidState("café"), false);
  for (const v of nonStrings) assert.equal(isValidState(v), false);
});

test("isValidRedirectUri", () => {
  assert.equal(isValidRedirectUri("http://localhost:1455/auth/callback"), true);
  assert.equal(isValidRedirectUri("https://platform.claude.com/oauth/code/callback"), true);
  const prefix = "http://localhost/";
  assert.equal(isValidRedirectUri(prefix + "a".repeat(LIMITS.redirectUri - prefix.length)), true);
  assert.equal(
    isValidRedirectUri(prefix + "a".repeat(LIMITS.redirectUri - prefix.length + 1)),
    false
  );
  assert.equal(isValidRedirectUri(""), false);
  assert.equal(isValidRedirectUri("not a url"), false);
  assert.equal(isValidRedirectUri("http://localhost:1455/cb?x=1"), false);
  assert.equal(isValidRedirectUri("http://localhost:1455/cb?"), false);
  assert.equal(isValidRedirectUri("http://localhost:1455/cb#f"), false);
  assert.equal(isValidRedirectUri("http://localhost:1455/cb#"), false);
  assert.equal(isValidRedirectUri("http://user:pw@localhost:1455/cb"), false);
  assert.equal(isValidRedirectUri("http://user@localhost:1455/cb"), false);
  assert.equal(isValidRedirectUri("javascript:alert(1)"), false);
  assert.equal(isValidRedirectUri("chrome-extension://abc/cb"), false);
  assert.equal(isValidRedirectUri("ftp://localhost/cb"), false);
  for (const v of nonStrings) assert.equal(isValidRedirectUri(v), false);
});

test("isValidOrigin", () => {
  assert.equal(isValidOrigin("http://localhost:20128"), true);
  assert.equal(isValidOrigin("https://omni.example.com"), true);
  assert.equal(isValidOrigin("http://localhost:20128/"), false);
  assert.equal(isValidOrigin("http://localhost:20128/path"), false);
  assert.equal(isValidOrigin("https://omni.example.com?x=1"), false);
  assert.equal(isValidOrigin("chrome-extension://abc"), false);
  assert.equal(isValidOrigin("javascript:alert(1)"), false);
  assert.equal(isValidOrigin("localhost"), false);
  assert.equal(isValidOrigin(""), false);
  assert.equal(isValidOrigin("https://" + "a".repeat(260) + ".com"), false);
  for (const v of nonStrings) assert.equal(isValidOrigin(v), false);
});

const goodArm = {
  type: MSG_ARM,
  requestId: "r1",
  provider: "codex",
  state: "st4te",
  redirectUri: "http://localhost:1455/auth/callback",
};

test("parseArmMessage ok", () => {
  const res = parseArmMessage({ ...goodArm, extra: "ignored", source: SOURCE_DASHBOARD });
  assert.deepEqual(res, {
    ok: true,
    value: {
      requestId: "r1",
      provider: "codex",
      state: "st4te",
      redirectUri: "http://localhost:1455/auth/callback",
    },
  });
});

test("parseArmMessage failures", () => {
  const bad = { ok: false, reason: REASONS.invalidMessage };
  assert.deepEqual(parseArmMessage(null), bad);
  assert.deepEqual(parseArmMessage(undefined), bad);
  assert.deepEqual(parseArmMessage("str"), bad);
  assert.deepEqual(parseArmMessage({ ...goodArm, type: "other" }), bad);
  assert.deepEqual(parseArmMessage({ ...goodArm, requestId: "bad id" }), bad);
  assert.deepEqual(parseArmMessage({ ...goodArm, provider: "Bad" }), bad);
  assert.deepEqual(parseArmMessage({ ...goodArm, state: "" }), bad);
  assert.deepEqual(parseArmMessage({ ...goodArm, redirectUri: "http://localhost/cb?x=1" }), bad);
  assert.deepEqual(parseArmMessage({ ...goodArm, redirectUri: undefined }), bad);
});

test("isDashboardArmMessage", () => {
  assert.equal(isDashboardArmMessage({ source: SOURCE_DASHBOARD, type: MSG_ARM }), true);
  assert.equal(isDashboardArmMessage({ source: SOURCE_EXTENSION, type: MSG_ARM }), false);
  assert.equal(isDashboardArmMessage({ source: SOURCE_DASHBOARD, type: MSG_READY }), false);
  assert.equal(isDashboardArmMessage({ type: MSG_ARM }), false);
  assert.equal(isDashboardArmMessage(null), false);
  assert.equal(isDashboardArmMessage("x"), false);
  assert.equal(isDashboardArmMessage(undefined), false);
});

test("isDashboardStatusMessage", () => {
  assert.equal(
    isDashboardStatusMessage({ source: SOURCE_DASHBOARD, type: MSG_BRIDGE_STATUS }),
    true
  );
  assert.equal(
    isDashboardStatusMessage({ source: SOURCE_EXTENSION, type: MSG_BRIDGE_STATUS }),
    false
  );
  assert.equal(isDashboardStatusMessage({ source: SOURCE_DASHBOARD, type: MSG_ARM }), false);
  assert.equal(isDashboardStatusMessage(null), false);
});

test("message builders", () => {
  assert.deepEqual(readyMessage("1.2.3"), {
    source: "omniroute-oauth-bridge",
    type: "ready",
    version: "1.2.3",
    approved: false,
  });
  assert.equal(readyMessage("1", true).approved, true);
  assert.equal(readyMessage("1", "yes" as unknown as boolean).approved, false);
  assert.deepEqual(approvedMessage("1.2.3"), {
    source: "omniroute-oauth-bridge",
    type: "approved",
    version: "1.2.3",
  });
  assert.deepEqual(armedMessage("r1"), {
    source: "omniroute-oauth-bridge",
    type: "oauth-bridge:armed",
    requestId: "r1",
  });
  assert.deepEqual(errorMessage("r1", REASONS.redirectNotAllowed), {
    source: "omniroute-oauth-bridge",
    type: "oauth-bridge:error",
    requestId: "r1",
    reason: "redirect-not-allowed",
  });
});
