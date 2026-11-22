import test from "node:test";
import assert from "node:assert/strict";

import {
  DASHBOARD_ORIGIN_REDIRECT_PROVIDERS,
  getExternalRedirect,
  resolveExternalRedirectUri,
} from "../../src/lib/oauth/externalRedirects.ts";
import {
  buildRegexFilter,
  matchAllowedRedirect,
} from "../../packages/oauth-bridge-extension/src/rules.js";

const STATE = "Abc_123-xyz";

/** Later-phase providers the extension can bridge, with the URI OAuthModal sends remotely. */
const SUPPORTED = [
  {
    provider: "devin-desktop",
    kind: "fixed-loopback",
    redirectUri: "http://127.0.0.1:59653/callback",
    // OAuthModal: resolveExternalRedirectUri(provider, window.location.port || "20128")
    sent: resolveExternalRedirectUri("devin-desktop", "20128"),
  },
  {
    provider: "renderhour",
    kind: "dashboard-port-loopback",
    redirectUri: "http://localhost:{port}/callback",
    sent: resolveExternalRedirectUri("renderhour", "20128"),
  },
] as const;

for (const p of SUPPORTED) {
  test(`${p.provider}: registry entry is bridge-supported, phase later`, () => {
    const entry = getExternalRedirect(p.provider);
    assert.ok(entry);
    assert.equal(entry.kind, p.kind);
    assert.equal(entry.redirectUri, p.redirectUri);
    assert.equal(entry.bridge, "supported");
    assert.equal(entry.phase, "later");
  });

  test(`${p.provider}: extension accepts the sent URI and matches a realistic landing`, () => {
    assert.ok(p.sent);
    assert.equal(matchAllowedRedirect(p.sent, p.provider), true);
    const re = new RegExp(buildRegexFilter(p.sent, STATE));
    const landing = `${p.sent}?code=AUTH_CODE_42&state=${STATE}`;
    const m = landing.match(re);
    assert.ok(m, landing);
    assert.equal(m[1], `code=AUTH_CODE_42&state=${STATE}`);
    assert.equal(re.test(`${p.sent}?code=AUTH_CODE_42&state=other`), false);
    assert.equal(re.test(`${p.sent}?code=AUTH_CODE_42`), false);
  });
}

test("renderhour: any dashboard port is accepted, the provider id is enforced", () => {
  const uri = resolveExternalRedirectUri("renderhour", "8443");
  assert.equal(uri, "http://localhost:8443/callback");
  assert.equal(matchAllowedRedirect(uri, "renderhour"), true);
  assert.equal(matchAllowedRedirect(uri, "devin-desktop"), false);
});

// zed-hosted moved to appended state mode (bridge-supported); see oauth-bridge-zed.test.ts.
const UNSUPPORTED = [{ provider: "devin-cli", reason: /Import-token only/ }] as const;

for (const p of UNSUPPORTED) {
  test(`${p.provider}: registry marks it unsupported with a reason`, () => {
    const entry = getExternalRedirect(p.provider);
    assert.ok(entry);
    assert.equal(entry.bridge, "unsupported");
    assert.equal(entry.phase, "later");
    assert.match(entry.notes ?? "", p.reason);
  });

  test(`${p.provider}: extension rejects its redirect URI`, () => {
    const uri = resolveExternalRedirectUri(p.provider, "58443");
    assert.ok(uri);
    assert.equal(matchAllowedRedirect(uri, p.provider), false);
  });
}

test("zed-hosted: its state-less native-app landing would never match a rule", () => {
  const uri = "http://127.0.0.1:58443/";
  const re = new RegExp(buildRegexFilter(uri, STATE));
  assert.equal(re.test(`${uri}?user_id=1&access_token=abc`), false);
});

for (const provider of ["cline", "clinepass"]) {
  test(`${provider}: lands on the dashboard origin, no bridge entry`, () => {
    assert.ok(DASHBOARD_ORIGIN_REDIRECT_PROVIDERS.includes(provider));
    assert.equal(getExternalRedirect(provider), undefined);
    assert.equal(matchAllowedRedirect("https://dash.example.com/callback", provider), false);
  });
}
