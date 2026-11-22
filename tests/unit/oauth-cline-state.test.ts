import test from "node:test";
import assert from "node:assert/strict";

const { cline, withClineCallbackState } = await import("../../src/lib/oauth/providers/cline.ts");
const { CLINE_CONFIG } = await import("../../src/lib/oauth/constants/oauth.ts");
const { generateAuthData } = await import("../../src/lib/oauth/providers.ts");
const { isCallbackStateAcceptable } =
  await import("../../src/shared/components/oauthCallbackState.ts");

const redirectUri = "http://localhost:20128/callback";

// Same parsing the callback page uses (src/app/callback/page.tsx: new URLSearchParams(location.search)).
function relayedParams(landingUrl: string) {
  const params = new URLSearchParams(new URL(landingUrl).search);
  return { code: params.get("code"), state: params.get("state") };
}

// Cline's auth service appends its code to the callback_url it was given.
function simulateClineLanding(authUrl: string, code: string) {
  const callbackUrl = new URL(new URL(authUrl).searchParams.get("callback_url") as string);
  callbackUrl.searchParams.set("code", code);
  return callbackUrl.toString();
}

function embeddedCode() {
  return Buffer.from(
    JSON.stringify({
      accessToken: "at",
      refreshToken: "rt",
      email: "user@example.com",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })
  ).toString("base64");
}

test("cline auth URL embeds the attempt state in callback_url and redirect_uri", () => {
  const url = new URL(cline.buildAuthUrl(CLINE_CONFIG, redirectUri, "attempt-state-123"));
  assert.equal(url.origin, "https://api.cline.bot");
  assert.equal(url.searchParams.get("client_type"), "extension");
  assert.equal(url.searchParams.get("callback_url"), `${redirectUri}?state=attempt-state-123`);
  assert.equal(url.searchParams.get("redirect_uri"), `${redirectUri}?state=attempt-state-123`);
});

test("generateAuthData for cline and clinepass puts authData.state into the callback URL", () => {
  for (const provider of ["cline", "clinepass"]) {
    const authData = generateAuthData(provider, redirectUri);
    assert.ok(authData.state, `${provider} has an attempt state`);
    const callbackUrl = new URL(new URL(authData.authUrl).searchParams.get("callback_url"));
    assert.equal(callbackUrl.searchParams.get("state"), authData.state);
    assert.equal(callbackUrl.origin + callbackUrl.pathname, redirectUri);
  }
});

test("relayed Cline landing URL yields the attempt state and passes the state check", () => {
  const authData = generateAuthData("cline", redirectUri);
  const landing = simulateClineLanding(authData.authUrl, embeddedCode());
  const { code, state } = relayedParams(landing);
  assert.equal(code, embeddedCode());
  assert.equal(state, authData.state);
  assert.equal(isCallbackStateAcceptable(authData.state, state), true);
});

test("state check is not weakened: missing or foreign state is still rejected", () => {
  assert.equal(isCallbackStateAcceptable("attempt-state", null), false);
  assert.equal(isCallbackStateAcceptable("attempt-state", "other-state"), false);
});

test("without a state the cline auth URL is unchanged", () => {
  const url = new URL(cline.buildAuthUrl(CLINE_CONFIG, redirectUri));
  assert.equal(url.searchParams.get("callback_url"), redirectUri);
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(withClineCallbackState(redirectUri, null), redirectUri);
});

test("withClineCallbackState keeps an existing query and replaces a stale state", () => {
  assert.equal(
    withClineCallbackState("https://host.test/callback?tkn=1&state=old", "new"),
    "https://host.test/callback?tkn=1&state=new"
  );
});

test("manual paste: embedded-token code still decodes, with or without state", async () => {
  for (const state of [undefined, "attempt-state"]) {
    const tokens = await cline.exchangeToken(CLINE_CONFIG, embeddedCode(), redirectUri, "v", state);
    assert.equal(tokens.access_token, "at");
    assert.equal(tokens.refresh_token, "rt");
    assert.equal(tokens.email, "user@example.com");
  }
});

test("token-endpoint fallback sends the same stateful redirect_uri used at authorize", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ data: { accessToken: "a", refreshToken: "r" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    await cline.exchangeToken(CLINE_CONFIG, "opaque-code", redirectUri, "v", "attempt-state");
    await cline.exchangeToken(CLINE_CONFIG, "opaque-code", redirectUri);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(bodies[0].redirect_uri, `${redirectUri}?state=attempt-state`);
  assert.equal(bodies[1].redirect_uri, redirectUri);
});
