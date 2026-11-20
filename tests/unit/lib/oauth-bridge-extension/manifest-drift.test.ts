import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import crypto from "node:crypto";

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

test("manifest key pins the documented extension ID", async () => {
  assert.equal(typeof manifest.key, "string");
  assert.ok(!/PRIVATE/.test(manifest.key));
  const der = Buffer.from(manifest.key, "base64");
  // Parses as an RSA SubjectPublicKeyInfo.
  const pub = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  assert.equal(pub.asymmetricKeyType, "rsa");
  const hex = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  const gen = await import("../../../../scripts/build/oauth-bridge-manifest.mjs");
  assert.equal(id, gen.EXTENSION_ID);
  const readme = fs.readFileSync(path.join(EXT, "README.md"), "utf8");
  assert.ok(readme.includes(id), "README records the extension ID");
});

test("web_accessible_resources expose ping.json and the approve page only", () => {
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["ping.json", "approve.html", "src/approve.js", "src/approve.css"],
      matches: ["<all_urls>"],
    },
  ]);
  for (const r of manifest.web_accessible_resources[0].resources) {
    assert.ok(fs.existsSync(path.join(EXT, r)), r);
  }
  const ping = JSON.parse(fs.readFileSync(path.join(EXT, "ping.json"), "utf8"));
  assert.deepEqual(ping, { name: "omniroute-oauth-bridge", version: 1 });
  const html = fs.readFileSync(path.join(EXT, "approve.html"), "utf8");
  assert.match(html, /src="src\/approve\.js"/);
  assert.match(html, /href="src\/approve\.css"/);
});

test("store package excludes tests and docs and drops the manifest key", async () => {
  const pkg = await import("../../../../scripts/build/oauth-bridge-package.mjs");
  const files: string[] = pkg.listPackageFiles();
  assert.ok(files.includes("manifest.json"));
  assert.ok(files.includes("ping.json"));
  assert.ok(files.includes("approve.html"));
  assert.ok(files.includes("src/background.js"));
  assert.ok(!files.some((f) => /README|\.test\./.test(f)));
  const os = await import("node:os");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "obx-pkg-"));
  try {
    const { file } = pkg.packageExtension({ outDir: out });
    const zip = fs.readFileSync(file);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    // Walk the local file headers and inflate manifest.json.
    const zlib = await import("node:zlib");
    const names: string[] = [];
    let packaged: Record<string, unknown> | null = null;
    for (let at = 0; zip.readUInt32LE(at) === 0x04034b50;) {
      const size = zip.readUInt32LE(at + 18);
      const nameLen = zip.readUInt16LE(at + 26);
      const extraLen = zip.readUInt16LE(at + 28);
      const name = zip.subarray(at + 30, at + 30 + nameLen).toString("utf8");
      const start = at + 30 + nameLen + extraLen;
      names.push(name);
      if (name === "manifest.json") {
        packaged = JSON.parse(zlib.inflateRawSync(zip.subarray(start, start + size)).toString());
      }
      at = start + size;
    }
    assert.deepEqual(names, files);
    assert.ok(packaged);
    assert.equal(packaged.key, undefined);
    assert.deepEqual(packaged.web_accessible_resources, manifest.web_accessible_resources);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
