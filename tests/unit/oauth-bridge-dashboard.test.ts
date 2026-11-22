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
  shouldStartLocalCallbackServer,
  shouldUseBridge,
} from "../../src/shared/components/oauthModal/useOAuthBridge";

const modalSource = readFileSync("src/shared/components/OAuthModal.tsx", "utf8");

const ORIGIN = "https://dash.example.com";
// Replies come from the bridge iframe's window on the extension origin, never from the page.
const EXT = "chrome-extension://gmckjokkoeeokoldknjmaipdbnceldil";
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
  assert.equal(isBridgeReadyMessage({ source: self, origin: EXT, data: ready }, self, EXT), true);
});

test("isBridgeReadyMessage rejects bad origin, source window, data source, type and data", () => {
  const ok = { source: self, origin: EXT, data: ready };
  assert.equal(
    isBridgeReadyMessage({ ...ok, origin: "https://evil.example.com" }, self, EXT),
    false
  );
  assert.equal(isBridgeReadyMessage({ ...ok, source: other }, self, EXT), false);
  // The dashboard page (or a script on it) posting a fake ready to itself.
  assert.equal(isBridgeReadyMessage({ ...ok, origin: ORIGIN }, self, EXT), false);
  // Another extension's frame.
  assert.equal(
    isBridgeReadyMessage(
      { ...ok, origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      self,
      EXT
    ),
    false
  );
  // No bridge frame mounted (frame window null).
  assert.equal(isBridgeReadyMessage(ok, null, EXT), false);
  assert.equal(
    isBridgeReadyMessage({ ...ok, data: { ...ready, source: "omniroute-dashboard" } }, self, EXT),
    false
  );
  assert.equal(isBridgeReadyMessage({ ...ok, data: { ...ready, source: "x" } }, self, EXT), false);
  assert.equal(
    isBridgeReadyMessage({ ...ok, data: { ...ready, type: "other" } }, self, EXT),
    false
  );
  assert.equal(isBridgeReadyMessage({ ...ok, data: "ready" }, self, EXT), false);
  assert.equal(isBridgeReadyMessage({ ...ok, data: 5 }, self, EXT), false);
  assert.equal(isBridgeReadyMessage({ ...ok, data: null }, self, EXT), false);
});

test("isBridgeReplyMessage accepts armed and error replies with matching requestId", () => {
  assert.equal(
    isBridgeReplyMessage({ source: self, origin: EXT, data: armed }, self, EXT, "r1"),
    true
  );
  assert.equal(
    isBridgeReplyMessage({ source: self, origin: EXT, data: errored }, self, EXT, "r1"),
    true
  );
});

test("isBridgeReplyMessage rejects mismatches and non-reply messages", () => {
  const ok = { source: self, origin: EXT, data: armed };
  assert.equal(isBridgeReplyMessage(ok, self, EXT, "r2"), false);
  assert.equal(
    isBridgeReplyMessage({ ...ok, data: { ...armed, requestId: "" } }, self, EXT, ""),
    false
  );
  assert.equal(
    isBridgeReplyMessage({ ...ok, origin: "https://evil.example.com" }, self, EXT, "r1"),
    false
  );
  assert.equal(isBridgeReplyMessage({ ...ok, source: other }, self, EXT, "r1"), false);
  assert.equal(
    isBridgeReplyMessage(
      { ...ok, data: { ...armed, source: "omniroute-dashboard" } },
      self,
      EXT,
      "r1"
    ),
    false
  );
  assert.equal(
    isBridgeReplyMessage({ ...ok, data: { ...ready, requestId: "r1" } }, self, EXT, "r1"),
    false
  );
  assert.equal(
    isBridgeReplyMessage(
      {
        ...ok,
        data: { source: "omniroute-dashboard", type: "oauth-bridge:arm", requestId: "r1" },
      },
      self,
      EXT,
      "r1"
    ),
    false
  );
});

test("shouldUseBridge matrix: same answer on every host", () => {
  for (const provider of ["codex", "openai", "claude", "xai-oauth", "grok-cli", "chatgpt"]) {
    assert.equal(shouldUseBridge({ provider, bridgeVersion: "1.0.0" }), true, provider);
  }
  for (const provider of ["antigravity", "agy", "not-a-provider", undefined, "cline"]) {
    assert.equal(shouldUseBridge({ provider, bridgeVersion: "1.0.0" }), false, String(provider));
  }
  for (const bridgeVersion of [null, undefined, ""]) {
    assert.equal(shouldUseBridge({ provider: "codex", bridgeVersion }), false);
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
      assert.equal(
        shouldUseBridge({ provider, bridgeVersion }),
        false,
        `${provider} use ${bridgeVersion}`
      );
      assert.equal(shouldShowBridgeHint(opts), false, `${provider} hint ${bridgeVersion}`);
    }
  }
  for (const provider of ["codex", "openai", "claude", "xai-oauth", "grok-cli", "chatgpt"]) {
    assert.equal(shouldUseBridge({ provider, bridgeVersion: "1.0.0" }), true, `${provider} use`);
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
  assert.match(modalSource, /bridgeArmRequestFrom\(provider, data, window\.location\.origin\)/);
  assert.doesNotMatch(modalSource, /redirectUri: String\(data\.redirectUri \|\| redirectUri\)/);
  // /authorize echoes the redirect it baked into authUrl; that exact value is armed.
  const serverRedirect = "http://localhost:20128/callback";
  const fromServer = bridgeArmRequestFrom(
    "renderhour",
    {
      authUrl: `https://auth.example/authorize?redirect_uri=${encodeURIComponent(serverRedirect)}`,
      state: "s1",
      redirectUri: serverRedirect,
    },
    ORIGIN
  );
  assert.deepEqual(fromServer, {
    provider: "renderhour",
    state: "s1",
    redirectUri: serverRedirect,
  });
  // A server that rewrote the redirect wins over the client's request.
  const rewritten = bridgeArmRequestFrom(
    "renderhour",
    { state: "s1", redirectUri: "http://localhost:8443/callback" },
    ORIGIN
  );
  assert.equal(rewritten?.redirectUri, "http://localhost:8443/callback");
  // No server redirectUri or state: nothing is armed (no client-guessed fallback).
  assert.equal(bridgeArmRequestFrom("renderhour", { state: "s1" }, ORIGIN), null);
  assert.equal(bridgeArmRequestFrom("renderhour", { redirectUri: serverRedirect }, ORIGIN), null);
  assert.equal(bridgeArmRequestFrom("renderhour", { state: "", redirectUri: "x" }, ORIGIN), null);
  assert.equal(bridgeArmRequestFrom("renderhour", null, ORIGIN), null);
  assert.equal(bridgeArmRequestFrom("renderhour", undefined, ORIGIN), null);
  assert.equal(shouldUseBridge({ provider: "renderhour", bridgeVersion: "1.0.0" }), true);
});

test("bridgeArmRequestFrom skips redirects to the dashboard's own origin", () => {
  const redirectUri = "http://localhost:20128/callback";
  const data = { state: "s1", redirectUri };
  // Local dashboard: renderhour lands on /callback by itself; the extension would reject it.
  assert.equal(bridgeArmRequestFrom("renderhour", data, "http://localhost:20128"), null);
  // 127.0.0.1 is a different origin from localhost, so it is still armed.
  assert.deepEqual(bridgeArmRequestFrom("renderhour", data, "http://127.0.0.1:20128"), {
    provider: "renderhour",
    ...data,
  });
  // Remote dashboard: the loopback redirect must be carried back, so it is armed.
  assert.deepEqual(bridgeArmRequestFrom("renderhour", data, ORIGIN), {
    provider: "renderhour",
    ...data,
  });
  // codex's fixed loopback never matches a local dashboard on another port.
  const codex = { state: "s2", redirectUri: "http://localhost:1455/auth/callback" };
  assert.ok(bridgeArmRequestFrom("codex", codex, "http://localhost:20128"));
  // An unparsable redirectUri is never armed.
  assert.equal(bridgeArmRequestFrom("renderhour", { state: "s1", redirectUri: "x" }, ORIGIN), null);
});

test("shouldStartLocalCallbackServer: extension skips the local server on any host", () => {
  const base = { isTrueLocalhost: true, bridgeVersion: "1.0.0", hasCallbackServer: true };
  // extension + localhost + callback-server provider => bridge, local server NOT started
  // (Docker on localhost: the server would bind inside the container, unreachable).
  for (const provider of ["codex", "xai-oauth", "grok-cli", "devin-desktop"]) {
    assert.equal(shouldUseBridge({ provider, bridgeVersion: "1.0.0" }), true, provider);
    assert.equal(shouldStartLocalCallbackServer({ ...base, provider }), false, provider);
  }
  // no extension + localhost => the local server path, exactly as on base
  for (const bridgeVersion of [null, undefined, ""]) {
    for (const provider of ["codex", "xai-oauth", "grok-cli", "devin-desktop"]) {
      assert.equal(shouldUseBridge({ provider, bridgeVersion }), false, provider);
      assert.equal(
        shouldStartLocalCallbackServer({ ...base, provider, bridgeVersion }),
        true,
        provider
      );
    }
  }
  // remote / LAN: never a local server, with or without the extension (unchanged)
  for (const bridgeVersion of ["1.0.0", null]) {
    assert.equal(
      shouldStartLocalCallbackServer({
        ...base,
        provider: "codex",
        isTrueLocalhost: false,
        bridgeVersion,
      }),
      false
    );
  }
  // providers without a callback server never start one
  for (const provider of ["openai", "claude", "renderhour", "antigravity"]) {
    for (const bridgeVersion of ["1.0.0", null]) {
      assert.equal(
        shouldStartLocalCallbackServer({
          ...base,
          provider,
          bridgeVersion,
          hasCallbackServer: false,
        }),
        false,
        provider
      );
    }
  }
  // OAuthModal uses the helper to gate the start-callback-server branch
  assert.match(modalSource, /shouldStartLocalCallbackServer\(\{/);
  assert.doesNotMatch(modalSource, /localServerStarted|shouldUseBridgeForAttempt/);
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

test("Claude on a remote dashboard arms the code page inside authUrl, not the echoed request", () => {
  // The modal requests `<dashboard>/callback`; Claude's authorize ignores it and bakes its own
  // code page into authUrl, while the response still echoes the requested redirect. Arming the
  // echo (same origin as the dashboard) meant no arm at all, and the user had to paste the code.
  const dashboard = "https://omniroute2.example.com";
  const codePage = "https://platform.claude.com/oauth/code/callback";
  const req = bridgeArmRequestFrom(
    "claude",
    {
      authUrl: `https://claude.ai/oauth/authorize?code=true&redirect_uri=${encodeURIComponent(codePage)}&state=cs`,
      state: "cs",
      redirectUri: `${dashboard}/callback`,
    },
    dashboard
  );
  assert.deepEqual(req, { provider: "claude", state: "cs", redirectUri: codePage });
});

test("an authUrl redirect_uri on the dashboard origin still needs no bridge", () => {
  const dashboard = "https://dash.example.com";
  const req = bridgeArmRequestFrom(
    "github",
    {
      authUrl: `https://idp.example/authorize?redirect_uri=${encodeURIComponent(`${dashboard}/callback`)}`,
      state: "s",
      redirectUri: `${dashboard}/callback`,
    },
    dashboard
  );
  assert.equal(req, null);
});
