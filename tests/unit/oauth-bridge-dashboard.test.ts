import { test } from "node:test";
import assert from "node:assert/strict";

import { EXTERNAL_REDIRECTS } from "../../src/lib/oauth/externalRedirects";
import {
  BRIDGE_ARM_TIMEOUT_MS,
  BRIDGE_DOCS_URL,
  BRIDGE_ENABLED_PHASES,
  isBridgeReadyMessage,
  isBridgeReplyMessage,
  isBridgeSupportedProvider,
  newBridgeRequestId,
  shouldShowBridgeHint,
  shouldUseBridge,
} from "../../src/shared/components/oauthModal/useOAuthBridge";

const ORIGIN = "https://dash.example.com";
const location = { origin: ORIGIN };
const self = {};
const other = {};

const ready = { source: "omniroute-oauth-bridge", type: "ready", version: "1.0.0" };
const armed = { source: "omniroute-oauth-bridge", type: "oauth-bridge:armed", requestId: "r1" };
const errored = {
  source: "omniroute-oauth-bridge",
  type: "oauth-bridge:error",
  requestId: "r1",
  reason: "x",
};

test("isBridgeReadyMessage accepts a correct ready message", () => {
  assert.equal(
    isBridgeReadyMessage({ source: self, origin: ORIGIN, data: ready }, location, self),
    true
  );
});

test("isBridgeReadyMessage rejects bad origin, source window, data source, type and data", () => {
  const ok = { source: self, origin: ORIGIN, data: ready };
  assert.equal(
    isBridgeReadyMessage({ ...ok, origin: "https://evil.example.com" }, location, self),
    false
  );
  assert.equal(isBridgeReadyMessage({ ...ok, source: other }, location, self), false);
  assert.equal(
    isBridgeReadyMessage(
      { ...ok, data: { ...ready, source: "omniroute-dashboard" } },
      location,
      self
    ),
    false
  );
  assert.equal(
    isBridgeReadyMessage({ ...ok, data: { ...ready, source: "x" } }, location, self),
    false
  );
  assert.equal(
    isBridgeReadyMessage({ ...ok, data: { ...ready, type: "other" } }, location, self),
    false
  );
  assert.equal(isBridgeReadyMessage({ ...ok, data: "ready" }, location, self), false);
  assert.equal(isBridgeReadyMessage({ ...ok, data: 5 }, location, self), false);
  assert.equal(isBridgeReadyMessage({ ...ok, data: null }, location, self), false);
});

test("isBridgeReplyMessage accepts armed and error replies with matching requestId", () => {
  assert.equal(
    isBridgeReplyMessage({ source: self, origin: ORIGIN, data: armed }, location, "r1", self),
    true
  );
  assert.equal(
    isBridgeReplyMessage({ source: self, origin: ORIGIN, data: errored }, location, "r1", self),
    true
  );
});

test("isBridgeReplyMessage rejects mismatches and non-reply messages", () => {
  const ok = { source: self, origin: ORIGIN, data: armed };
  assert.equal(isBridgeReplyMessage(ok, location, "r2", self), false);
  assert.equal(
    isBridgeReplyMessage({ ...ok, data: { ...armed, requestId: "" } }, location, "", self),
    false
  );
  assert.equal(
    isBridgeReplyMessage({ ...ok, origin: "https://evil.example.com" }, location, "r1", self),
    false
  );
  assert.equal(isBridgeReplyMessage({ ...ok, source: other }, location, "r1", self), false);
  assert.equal(
    isBridgeReplyMessage(
      { ...ok, data: { ...armed, source: "omniroute-dashboard" } },
      location,
      "r1",
      self
    ),
    false
  );
  assert.equal(
    isBridgeReplyMessage({ ...ok, data: { ...ready, requestId: "r1" } }, location, "r1", self),
    false
  );
  assert.equal(
    isBridgeReplyMessage(
      {
        ...ok,
        data: { source: "omniroute-dashboard", type: "oauth-bridge:arm", requestId: "r1" },
      },
      location,
      "r1",
      self
    ),
    false
  );
});

test("shouldUseBridge matrix", () => {
  for (const provider of ["codex", "openai", "claude", "xai-oauth", "grok-cli", "chatgpt"]) {
    assert.equal(
      shouldUseBridge({ provider, isTrueLocalhost: false, bridgeVersion: "1.0.0" }),
      true,
      provider
    );
    assert.equal(
      shouldUseBridge({ provider, isTrueLocalhost: true, bridgeVersion: "1.0.0" }),
      false,
      provider
    );
  }
  for (const provider of ["antigravity", "agy", "not-a-provider", undefined, "cline"]) {
    assert.equal(
      shouldUseBridge({ provider, isTrueLocalhost: false, bridgeVersion: "1.0.0" }),
      false,
      String(provider)
    );
  }
  for (const bridgeVersion of [null, undefined, ""]) {
    assert.equal(
      shouldUseBridge({ provider: "codex", isTrueLocalhost: false, bridgeVersion }),
      false
    );
  }
});

test("shouldShowBridgeHint", () => {
  assert.equal(
    shouldShowBridgeHint({ provider: "codex", isTrueLocalhost: false, bridgeVersion: null }),
    true
  );
  assert.equal(
    shouldShowBridgeHint({ provider: "codex", isTrueLocalhost: false, bridgeVersion: "1.0.0" }),
    false
  );
  assert.equal(
    shouldShowBridgeHint({ provider: "codex", isTrueLocalhost: true, bridgeVersion: null }),
    false
  );
  assert.equal(
    shouldShowBridgeHint({ provider: "antigravity", isTrueLocalhost: false, bridgeVersion: null }),
    false
  );
});

test("isBridgeSupportedProvider agrees with the registry", () => {
  for (const entry of EXTERNAL_REDIRECTS) {
    assert.equal(
      isBridgeSupportedProvider(entry.provider),
      entry.bridge === "supported" && ["major", "later"].includes(entry.phase),
      entry.provider
    );
  }
  assert.equal(isBridgeSupportedProvider(undefined), false);
});

test("newBridgeRequestId returns distinct non-empty strings", () => {
  const a = newBridgeRequestId();
  const b = newBridgeRequestId();
  assert.ok(a.length > 0 && b.length > 0);
  assert.notEqual(a, b);
});

test("bridge constants", () => {
  assert.equal(BRIDGE_ARM_TIMEOUT_MS, 1500);
  assert.ok(BRIDGE_DOCS_URL.endsWith("#sign-in-helper-extension"));
});

test("major and later phase providers are bridged; unsupported ones never (phase gate)", () => {
  assert.deepEqual([...BRIDGE_ENABLED_PHASES], ["major", "later"]);
  for (const provider of ["antigravity", "agy", "not-a-provider"]) {
    for (const bridgeVersion of ["1.0.0", null]) {
      const opts = { provider, isTrueLocalhost: false, bridgeVersion };
      assert.equal(shouldUseBridge(opts), false, `${provider} use ${bridgeVersion}`);
      assert.equal(shouldShowBridgeHint(opts), false, `${provider} hint ${bridgeVersion}`);
    }
  }
  for (const provider of ["codex", "openai", "claude", "xai-oauth", "grok-cli", "chatgpt"]) {
    assert.equal(
      shouldUseBridge({ provider, isTrueLocalhost: false, bridgeVersion: "1.0.0" }),
      true,
      `${provider} use`
    );
    assert.equal(
      shouldShowBridgeHint({ provider, isTrueLocalhost: false, bridgeVersion: null }),
      true,
      `${provider} hint`
    );
  }
});
