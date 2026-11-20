import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PROVIDERS } from "../../src/lib/oauth/providers/index";
import {
  DASHBOARD_ORIGIN_REDIRECT_PROVIDERS,
  EXTERNAL_REDIRECTS,
  callbackPortOf,
  getExternalRedirect,
  resolveExternalRedirectUri,
} from "../../src/lib/oauth/externalRedirects";

// The registry is the one source of truth for OAuth redirects that do not land on the
// dashboard origin. A new authorization-code provider must be classified here, so a
// browser extension (and the modal) never silently miss its redirect.

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(resolve(here, "../../src", rel), "utf8");

const AUTH_CODE_FLOWS = new Set(["authorization_code", "authorization_code_pkce"]);

test("every authorization-code provider is classified exactly once", () => {
  const external = new Set(EXTERNAL_REDIRECTS.map((entry) => entry.provider));
  const dashboard = new Set(DASHBOARD_ORIGIN_REDIRECT_PROVIDERS);
  const authCodeProviders = Object.entries(PROVIDERS)
    .filter(([, mod]) => AUTH_CODE_FLOWS.has((mod as { flowType?: string }).flowType ?? ""))
    .map(([id]) => id);

  assert.ok(authCodeProviders.length > 0, "expected authorization-code providers in the index");
  for (const id of authCodeProviders) {
    const inExternal = external.has(id);
    const inDashboard = dashboard.has(id);
    assert.ok(inExternal || inDashboard, `${id} is in neither registry list`);
    assert.ok(!(inExternal && inDashboard), `${id} is in both registry lists`);
  }
});

test("registry entries are unique and never also dashboard-origin", () => {
  const ids = EXTERNAL_REDIRECTS.map((entry) => entry.provider);
  assert.equal(new Set(ids).size, ids.length, "duplicate provider in EXTERNAL_REDIRECTS");
  for (const id of ids) {
    assert.ok(!DASHBOARD_ORIGIN_REDIRECT_PROVIDERS.includes(id), `${id} is in both lists`);
  }
});

test("hostPermission covers each redirectUri and every URI parses", () => {
  for (const entry of EXTERNAL_REDIRECTS) {
    const url = new URL(entry.redirectUri.replace("{port}", "20128"));
    const match = entry.hostPermission.match(/^(https?):\/\/([^/]+)\/\*$/);
    assert.ok(match, `${entry.provider}: hostPermission ${entry.hostPermission} is not a pattern`);
    assert.equal(`${match![1]}:`, url.protocol, `${entry.provider}: scheme mismatch`);
    assert.equal(match![2], url.hostname, `${entry.provider}: host mismatch`);
    assert.equal(
      entry.kind === "dashboard-port-loopback",
      entry.redirectUri.includes("{port}"),
      `${entry.provider}: only dashboard-port-loopback entries carry {port}`
    );
  }
});

test("resolveExternalRedirectUri returns the modal's historical values", () => {
  const port = "20128";
  const expected: Record<string, string> = {
    codex: "http://localhost:1455/auth/callback",
    openai: "http://localhost:1455/auth/callback",
    "xai-oauth": "http://127.0.0.1:56121/callback",
    "grok-cli": "http://127.0.0.1:56122/callback",
    "devin-desktop": "http://127.0.0.1:59653/callback",
    "devin-cli": `http://localhost:${port}/auth/callback`,
    antigravity: `http://127.0.0.1:${port}/callback`,
    agy: `http://127.0.0.1:${port}/callback`,
    renderhour: `http://localhost:${port}/callback`,
  };
  for (const [provider, uri] of Object.entries(expected)) {
    assert.equal(resolveExternalRedirectUri(provider, port), uri, provider);
  }
  assert.equal(resolveExternalRedirectUri("qoder", port), undefined);
});

test("callbackPortOf and the major phase", () => {
  assert.equal(callbackPortOf(getExternalRedirect("codex")!), 1455);
  assert.equal(callbackPortOf(getExternalRedirect("xai-oauth")!), 56121);
  assert.equal(callbackPortOf(getExternalRedirect("antigravity")!), null);
  assert.equal(callbackPortOf(getExternalRedirect("claude")!), null);
  const major = EXTERNAL_REDIRECTS.filter((e) => e.phase === "major").map((e) => e.provider);
  assert.deepEqual(major.sort(), ["claude", "codex", "grok-cli", "openai", "xai-oauth"]);
  assert.equal(getExternalRedirect("antigravity")!.bridge, "unsupported");
  assert.equal(getExternalRedirect("agy")!.bridge, "unsupported");
});

test("OAuthModal and pkceLoopbackWarning hold no hard-coded loopback ports", () => {
  for (const rel of [
    "shared/components/OAuthModal.tsx",
    "lib/oauth/utils/pkceLoopbackWarning.ts",
  ]) {
    const src = readSrc(rel);
    assert.doesNotMatch(src, /localhost:\d/, `${rel} still hard-codes localhost:<port>`);
    assert.doesNotMatch(src, /127\.0\.0\.1:\d/, `${rel} still hard-codes 127.0.0.1:<port>`);
  }
});
