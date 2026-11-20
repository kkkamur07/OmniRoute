import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { getExternalRedirect } from "../../src/lib/oauth/externalRedirects.ts";
import {
  bridgeArmRequestFrom,
  isBridgeSupportedProvider,
  shouldUseBridge,
} from "../../src/shared/components/oauthModal/useOAuthBridge.ts";
import { isCallbackStateAcceptable } from "../../src/shared/components/oauthCallbackState.ts";
import { generateAuthData } from "../../src/lib/oauth/providers.ts";
import {
  createZedNativeAuthData,
  decryptZedAccessToken,
  parseZedCallbackPayload,
} from "../../open-sse/shared/zedAuth.ts";

const DASHBOARD = "https://dash.example";

/** Public key from the sign-in URL: base64 (url alphabet, padded) PKCS#1 DER, as Zed reads it. */
function publicKeyFromAuthUrl(authUrl: string): crypto.KeyObject {
  const raw = new URL(authUrl).searchParams.get("native_app_public_key") || "";
  const der = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return crypto.createPublicKey({ key: der, format: "der", type: "pkcs1" });
}

/** What the extension relays: the native-app query with the armed state appended last. */
function relayedUrl(userId: string, encryptedToken: string, state: string): string {
  const query = new URLSearchParams({ user_id: userId, access_token: encryptedToken });
  return `${DASHBOARD}/callback?${query.toString()}&state=${encodeURIComponent(state)}`;
}

/** src/app/callback/page.tsx: user_id + access_token and no code means code = full URL. */
function callbackRelayData(href: string): { code: string | null; state: string | null } {
  const params = new URL(href).searchParams;
  let code = params.get("code");
  if (!code && params.get("access_token") && params.get("user_id")) code = href;
  return { code, state: params.get("state") };
}

test("zed-hosted registry entry is bridge-supported in appended state mode", () => {
  const entry = getExternalRedirect("zed-hosted");
  assert.ok(entry);
  assert.equal(entry.bridge, "supported");
  assert.equal(entry.phase, "later");
  assert.equal(entry.stateMode, "appended");
  assert.deepEqual(entry.requiredParams, ["user_id", "access_token"]);
  assert.equal(entry.redirectUri, "http://127.0.0.1:{port}/");
});

test("zed-hosted is bridge-supported and used whenever the extension is present", () => {
  assert.equal(isBridgeSupportedProvider("zed-hosted"), true);
  assert.equal(shouldUseBridge({ provider: "zed-hosted", bridgeVersion: "1" }), true);
  assert.equal(shouldUseBridge({ provider: "zed-hosted", bridgeVersion: null }), false);
});

test("a remote zed-hosted /authorize response arms its own state and 127.0.0.1:58443", () => {
  // Remote dashboard: OAuthModal requests <origin>/callback; the port stays the default.
  const data = generateAuthData("zed-hosted", `${DASHBOARD}/callback`) as Record<string, unknown>;
  assert.equal(typeof data.state, "string");
  assert.ok(data.state);
  assert.equal(data.redirectUri, "http://127.0.0.1:58443/");
  assert.deepEqual(bridgeArmRequestFrom("zed-hosted", data, DASHBOARD), {
    provider: "zed-hosted",
    state: data.state,
    redirectUri: "http://127.0.0.1:58443/",
  });
});

test("the relayed callback must echo the armed state", () => {
  assert.equal(isCallbackStateAcceptable("S", "S"), true);
  assert.equal(isCallbackStateAcceptable("S", null), false);
  assert.equal(isCallbackStateAcceptable("S", undefined), false);
  assert.equal(isCallbackStateAcceptable("S", "other"), false);
});

test("a stateless native-app landing relayed as-is is rejected", () => {
  const relay = callbackRelayData(`${DASHBOARD}/callback?user_id=1&access_token=X`);
  assert.ok(relay.code);
  assert.equal(relay.state, null);
  assert.equal(isCallbackStateAcceptable("S", relay.state), false);
});

test("parseZedCallbackPayload ignores the appended state param", () => {
  const parsed = parseZedCallbackPayload(`${DASHBOARD}/callback?user_id=1&access_token=X&state=S`);
  assert.deepEqual(parsed, { userId: "1", encryptedAccessToken: "X" });
});

for (const [label, padding] of [
  ["OAEP sha256", crypto.constants.RSA_PKCS1_OAEP_PADDING],
  ["PKCS#1 v1.5", crypto.constants.RSA_PKCS1_PADDING],
] as const) {
  test(`round trip (${label}): encrypt like Zed, relay with state, parse and decrypt`, () => {
    const auth = createZedNativeAuthData({}, { nativeAppPort: 58443 });
    const publicKey = publicKeyFromAuthUrl(auth.authUrl);
    const encrypted = crypto
      .publicEncrypt(
        padding === crypto.constants.RSA_PKCS1_OAEP_PADDING
          ? { key: publicKey, padding, oaepHash: "sha256" }
          : { key: publicKey, padding },
        Buffer.from("zed-access-token-123")
      )
      .toString("base64url");

    const state = "armed_State-42";
    const relay = callbackRelayData(relayedUrl("4242", encrypted, state));
    assert.equal(isCallbackStateAcceptable(state, relay.state), true);

    // OAuthModal exchangeTokens(code, state) posts code = the full relayed URL; zed-hosted's
    // exchangeToken runs exactly these two calls before any network request.
    const { userId, encryptedAccessToken } = parseZedCallbackPayload(relay.code);
    assert.equal(userId, "4242");
    assert.equal(
      decryptZedAccessToken(encryptedAccessToken, auth.privateKeyVerifier),
      "zed-access-token-123"
    );
  });
}
