import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-oauth-classify-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { PROVIDERS } = await import("../../src/lib/oauth/providers/index.ts");
const redirects = await import("../../src/lib/oauth/externalRedirects.ts");
const cats = await import("../../src/lib/oauth/onboardingCategories.ts");

const { EXTERNAL_REDIRECTS, DASHBOARD_ORIGIN_REDIRECT_PROVIDERS } = redirects;
const {
  OAUTH_ONBOARDING_CATEGORIES,
  classifyOAuthProvider,
  classifyAllOAuthProviders,
  listOAuthProviderIds,
  getOAuthProviderFlowType,
  isAuthorizationCodeFlow,
} = cats;

const BRIDGE_CATEGORY: Record<string, string> = {
  "fixed-loopback": "bridge-fixed-loopback",
  "dashboard-port-loopback": "bridge-dashboard-port-loopback",
  "provider-code-page": "bridge-provider-code-page",
};

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function allIds(): string[] {
  return [
    ...new Set([
      ...Object.keys(PROVIDERS),
      ...EXTERNAL_REDIRECTS.map((e) => e.provider),
      ...DASHBOARD_ORIGIN_REDIRECT_PROVIDERS,
    ]),
  ];
}

test("every OAuth provider gets exactly one known category", () => {
  for (const id of allIds()) {
    const result = classifyOAuthProvider(id);
    assert.ok(result, `${id} could not be classified`);
    assert.ok(
      (OAUTH_ONBOARDING_CATEGORIES as readonly string[]).includes(result.category),
      `${id} has unknown category ${result.category}`
    );
    assert.equal(result.provider, id);
  }
});

test("authorization-code providers are listed in the redirect registry", () => {
  for (const id of Object.keys(PROVIDERS)) {
    if (!isAuthorizationCodeFlow(getOAuthProviderFlowType(id))) continue;
    const listed =
      EXTERNAL_REDIRECTS.some((e) => e.provider === id) ||
      DASHBOARD_ORIGIN_REDIRECT_PROVIDERS.includes(id);
    assert.ok(
      listed,
      `${id} uses an authorization-code flow but has no redirect classification. Add an entry to src/lib/oauth/externalRedirects.ts (EXTERNAL_REDIRECTS or DASHBOARD_ORIGIN_REDIRECT_PROVIDERS).`
    );
  }
});

test("classification rules follow the registry", () => {
  for (const entry of EXTERNAL_REDIRECTS) {
    const result = classifyOAuthProvider(entry.provider);
    assert.ok(result, entry.provider);
    const flowType = getOAuthProviderFlowType(entry.provider);
    if (entry.bridge === "supported") {
      assert.equal(result.category, BRIDGE_CATEGORY[entry.kind], entry.provider);
    } else if (DASHBOARD_ORIGIN_REDIRECT_PROVIDERS.includes(entry.provider)) {
      assert.equal(result.category, "dashboard-origin-callback", entry.provider);
    } else if (flowType === "import_token") {
      assert.equal(result.category, "import-token", entry.provider);
    } else if (flowType === "device_code") {
      assert.equal(result.category, "device-code", entry.provider);
    } else {
      assert.equal(result.category, "manual-only", entry.provider);
      if (entry.notes) assert.equal(result.reason, entry.notes, entry.provider);
    }
  }
  for (const id of DASHBOARD_ORIGIN_REDIRECT_PROVIDERS) {
    const entry = EXTERNAL_REDIRECTS.find((e) => e.provider === id);
    if (entry?.bridge === "supported") continue;
    assert.equal(classifyOAuthProvider(id)?.category, "dashboard-origin-callback", id);
  }
  const registry = new Set(EXTERNAL_REDIRECTS.map((e) => e.provider));
  for (const id of Object.keys(PROVIDERS)) {
    if (registry.has(id) || DASHBOARD_ORIGIN_REDIRECT_PROVIDERS.includes(id)) continue;
    const flowType = getOAuthProviderFlowType(id);
    if (flowType === "device_code") {
      assert.equal(classifyOAuthProvider(id)?.category, "device-code", id);
    } else if (flowType === "import_token") {
      assert.equal(classifyOAuthProvider(id)?.category, "import-token", id);
    }
  }
});

test("classifyAll has unique ids, matches the id list, and every reason is non-empty", () => {
  const all = classifyAllOAuthProviders();
  const ids = all.map((r) => r.provider);
  assert.equal(new Set(ids).size, ids.length, "duplicate provider in classification");
  assert.equal(all.length, listOAuthProviderIds().length);
  for (const r of all) {
    assert.equal(typeof r.reason, "string", r.provider);
    assert.ok(r.reason.length > 0, `${r.provider} has an empty reason`);
  }
});

test("unknown provider id returns undefined", () => {
  assert.equal(classifyOAuthProvider("definitely-not-a-provider"), undefined);
});

test("named providers land in the expected category", () => {
  const expected: Record<string, string> = {
    codex: "bridge-fixed-loopback",
    claude: "bridge-provider-code-page",
    github: "device-code",
    cursor: "import-token",
    "zed-hosted": "bridge-dashboard-port-loopback",
    qoder: "dashboard-origin-callback",
    chatgpt: "bridge-fixed-loopback",
    "copilot-m365-web": "bridge-provider-code-page",
  };
  for (const [id, category] of Object.entries(expected)) {
    assert.equal(classifyOAuthProvider(id)?.category, category, id);
  }
});
