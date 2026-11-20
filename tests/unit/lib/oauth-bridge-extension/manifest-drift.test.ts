import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EXTERNAL_REDIRECTS } from "../../../../src/lib/oauth/externalRedirects.ts";
import { ALLOWED_REDIRECTS } from "../../../../packages/oauth-bridge-extension/src/allowedRedirects.generated.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const EXT = path.join(ROOT, "packages", "oauth-bridge-extension");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

test("generated manifest and allow-list are up to date", () => {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "scripts/build/oauth-bridge-manifest.mjs", "--check"],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /up to date/);
});

test("manifest basics and permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "OmniRoute Sign-in Helper");
  assert.deepEqual(manifest.permissions, [
    "declarativeNetRequest",
    "storage",
    "scripting",
    "webNavigation",
    "alarms",
    "activeTab",
  ]);
  // activeTab (not tabs) is what lets the popup read the focused dashboard tab's URL.
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(!manifest.permissions.includes("tabs"));
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  for (const p of [...manifest.host_permissions, ...manifest.permissions]) {
    assert.notEqual(p, "<all_urls>");
  }
});

test("host_permissions match the supported registry entries", () => {
  const expected = [
    ...new Set(
      EXTERNAL_REDIRECTS.filter((e) => e.bridge === "supported").map((e) => e.hostPermission)
    ),
  ].sort();
  assert.deepEqual(manifest.host_permissions, expected);
});

test("every provider-code-page origin is covered by host_permissions", () => {
  const registry = EXTERNAL_REDIRECTS.filter(
    (e) => e.bridge === "supported" && e.kind === "provider-code-page"
  );
  const generated = ALLOWED_REDIRECTS.filter((e) => e.kind === "provider-code-page");
  assert.ok(registry.length > 0);
  assert.ok(generated.length > 0);
  for (const e of [...registry, ...generated]) {
    const pattern = `${new URL(e.redirectUri).origin}/*`;
    assert.ok(manifest.host_permissions.includes(pattern), `${e.provider}: ${pattern}`);
  }
});

test("referenced files exist", () => {
  const exists = (rel: string) => fs.existsSync(path.join(EXT, rel));
  assert.ok(exists(manifest.background.service_worker));
  assert.ok(exists(manifest.action.default_popup));
  assert.ok(exists("src/content.js"));
  const html = fs.readFileSync(path.join(EXT, manifest.action.default_popup), "utf8");
  const dir = path.dirname(manifest.action.default_popup);
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length > 0);
  for (const s of srcs) assert.ok(exists(path.join(dir, s)), s);
});

test("README provider section is delimited and lists every registry provider", () => {
  const readme = fs.readFileSync(path.join(EXT, "README.md"), "utf8");
  const startMarker = "<!-- oauth-bridge:providers:start -->";
  const endMarker = "<!-- oauth-bridge:providers:end -->";
  assert.ok(readme.includes(startMarker));
  assert.ok(readme.includes(endMarker));
  const section = readme.slice(readme.indexOf(startMarker), readme.indexOf(endMarker));
  const unsupportedAt = section.indexOf("Unsupported:");
  assert.ok(unsupportedAt > 0);
  const table = section.slice(0, unsupportedAt);
  const unsupportedPart = section.slice(unsupportedAt);
  for (const e of EXTERNAL_REDIRECTS) {
    if (e.bridge === "supported") {
      assert.ok(table.includes(`\`${e.provider}\``), e.provider);
      assert.ok(table.includes(e.redirectUri), e.redirectUri);
    } else {
      assert.ok(unsupportedPart.includes(`\`${e.provider}\``), e.provider);
    }
  }
});
