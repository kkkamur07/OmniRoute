import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import {
  EXTERNAL_REDIRECTS,
  resolveExternalRedirectUri,
} from "../../src/lib/oauth/externalRedirects";
import {
  BRIDGE_ARM_TIMEOUT_MS,
  BRIDGE_DOCS_URL,
  BRIDGE_ENABLED_PHASES,
  bridgeArmRequestFrom,
  isBridgeReadyMessage,
  isBridgeReplyMessage,
  isBridgeSupportedProvider,
  newBridgeRequestId,
  shouldShowBridgeHint,
  shouldUseBridge,
  shouldUseBridgeForAttempt,
} from "../../src/shared/components/oauthModal/useOAuthBridge";

const modalSource = readFileSync("src/shared/components/OAuthModal.tsx", "utf8");

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

test("hosted https dashboard on 443 (location.port empty): renderhour arms the server redirectUri", () => {
  const loc = { hostname: "dash.example.com", port: "", protocol: "https:" };
  // OAuthModal requests resolveExternalRedirectUri(provider, location.port || "20128").
  assert.match(
    modalSource,
    /resolveExternalRedirectUri\(provider, window\.location\.port \|\| "20128"\)/
  );
  const requested = resolveExternalRedirectUri("renderhour", loc.port || "20128");
  // The request falls back to the default dashboard port; it never invents 443.
  assert.equal(requested, "http://localhost:20128/callback");
  // What is armed comes from the /authorize response, not from `redirectUri` (the request).
  assert.match(modalSource, /bridgeArmRequestFrom\(provider, data\)/);
  assert.doesNotMatch(modalSource, /redirectUri: String\(data\.redirectUri \|\| redirectUri\)/);
  // /authorize echoes the redirect it baked into authUrl; that exact value is armed.
  const serverRedirect = "http://localhost:20128/callback";
  const fromServer = bridgeArmRequestFrom("renderhour", {
    authUrl: `https://auth.example/authorize?redirect_uri=${encodeURIComponent(serverRedirect)}`,
    state: "s1",
    redirectUri: serverRedirect,
  });
  assert.deepEqual(fromServer, {
    provider: "renderhour",
    state: "s1",
    redirectUri: serverRedirect,
  });
  // A server that rewrote the redirect wins over the client's request.
  const rewritten = bridgeArmRequestFrom("renderhour", {
    state: "s1",
    redirectUri: "http://localhost:8443/callback",
  });
  assert.equal(rewritten?.redirectUri, "http://localhost:8443/callback");
  // No server redirectUri or state: nothing is armed (no client-guessed fallback).
  assert.equal(bridgeArmRequestFrom("renderhour", { state: "s1" }), null);
  assert.equal(bridgeArmRequestFrom("renderhour", { redirectUri: serverRedirect }), null);
  assert.equal(bridgeArmRequestFrom("renderhour", { state: "", redirectUri: "x" }), null);
  assert.equal(bridgeArmRequestFrom("renderhour", null), null);
  assert.equal(
    shouldUseBridgeForAttempt({
      provider: "renderhour",
      isTrueLocalhost: false,
      bridgeVersion: "1.0.0",
      localCallbackServerStarted: false,
    }),
    true
  );
});

test("shouldUseBridgeForAttempt on true localhost", () => {
  const base = { isTrueLocalhost: true, bridgeVersion: "1.0.0", localCallbackServerStarted: false };
  // extension + supported provider + no local callback server => bridge
  for (const provider of ["codex", "openai", "claude", "xai-oauth", "grok-cli", "renderhour"]) {
    assert.equal(shouldUseBridgeForAttempt({ ...base, provider }), true, provider);
  }
  // this attempt started OmniRoute's own local callback server => no bridge
  for (const provider of ["codex", "xai-oauth", "grok-cli", "devin-desktop"]) {
    assert.equal(
      shouldUseBridgeForAttempt({ ...base, provider, localCallbackServerStarted: true }),
      false,
      provider
    );
  }
  // no extension => no bridge
  for (const bridgeVersion of [null, undefined, ""]) {
    assert.equal(shouldUseBridgeForAttempt({ ...base, provider: "codex", bridgeVersion }), false);
  }
  // unsupported providers never
  for (const provider of ["antigravity", "agy", "zed-hosted", "devin-cli", undefined]) {
    assert.equal(shouldUseBridgeForAttempt({ ...base, provider }), false, String(provider));
  }
  // the remote decision is unchanged and ignores the local-server flag
  for (const provider of ["codex", "claude", "renderhour"]) {
    for (const localCallbackServerStarted of [false, true]) {
      assert.equal(
        shouldUseBridgeForAttempt({
          ...base,
          provider,
          isTrueLocalhost: false,
          localCallbackServerStarted,
        }),
        shouldUseBridge({ provider, isTrueLocalhost: false, bridgeVersion: "1.0.0" }),
        provider
      );
    }
  }
});

test("install hint stays remote-only: never on true localhost", () => {
  for (const provider of ["codex", "openai", "claude", "renderhour"]) {
    assert.equal(
      shouldShowBridgeHint({ provider, isTrueLocalhost: true, bridgeVersion: null }),
      false,
      provider
    );
    assert.equal(
      shouldShowBridgeHint({ provider, isTrueLocalhost: false, bridgeVersion: null }),
      true,
      provider
    );
  }
});
