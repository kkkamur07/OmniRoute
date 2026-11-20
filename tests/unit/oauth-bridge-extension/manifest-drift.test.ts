import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EXTERNAL_REDIRECTS } from "../../../src/lib/oauth/externalRedirects.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
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
  ]);
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
