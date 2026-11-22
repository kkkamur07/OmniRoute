#!/usr/bin/env node

/**
 * oauth-bridge-manifest.mjs: generates the OAuth bridge extension's host_permissions and
 * redirect allow-list from the single registry in src/lib/oauth/externalRedirects.ts.
 *
 * Usage: node --import tsx/esm scripts/build/oauth-bridge-manifest.mjs [--check]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as prettier from "prettier";
import { EXTERNAL_REDIRECTS } from "../../src/lib/oauth/externalRedirects.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT_DIR = path.join(ROOT, "packages", "oauth-bridge-extension");
export const MANIFEST_PATH = path.join(EXT_DIR, "manifest.json");
export const README_PATH = path.join(EXT_DIR, "README.md");
export const ALLOWED_PATH = path.join(EXT_DIR, "src", "allowedRedirects.generated.js");

// Public half of the extension signing key. It pins the unpacked extension ID to
// EXTENSION_ID below so the dashboard can embed bridge.html and open approve.html. The private key is
// never committed; the Chrome Web Store signs published builds with its own key.
export const MANIFEST_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmfZ3zejOVOabJdSzPpxHFov6KTc73n/AadCWYidkLWesLKbgF/RRVNrhCwUkZYJcbRdRo+qa5QLdN6frjeQEU51BmmHQb2c6MGuQBDK9srWZw3HI3ehHYuvx7VCU/p53X7N3V0n+ptjN7E3yyiiGVIApGJs/7EIIN/Ny9yzlRAtzmCAmRQbAuzAIpFDhSpew/4ww5h6WBccXsn/wczAttKLDfGNEnBsnSbDDs7lymKavkSPy7MXJX2wbHYPjrfiZy6vXhneBP+rCD+6AFBJacM6E6vxAXSMSX2tNuI1/ig7IvbJUmkDk8YpuHE0F1YNuD0ngYL6mlz3EESVv4k8FZwIDAQAB";
export const EXTENSION_ID = "gmckjokkoeeokoldknjmaipdbnceldil";

// Pages the dashboard may load: bridge.html (the hidden frame it talks to; its `ready` message
// doubles as install detection) and the approve page opened with window.open. Fixed here so the
// checked-in manifest cannot drift.
export const WEB_ACCESSIBLE_RESOURCES = [
  {
    resources: [
      "approve.html",
      "bridge.html",
      "src/approve.js",
      "src/approve.css",
      "src/bridge.js",
    ],
    matches: ["<all_urls>"],
  },
];

// The MV3 minimum. No frame-ancestors: bridge.html must be framable by any dashboard origin.
// approve.html defends itself instead (isFramed in approve.js, plus the worker rejecting an
// approval that is not from a top-level tab).
export const CONTENT_SECURITY_POLICY = {
  extension_pages: "script-src 'self'; object-src 'self'",
};

export const BASE_MANIFEST = {
  manifest_version: 3,
  name: "OmniRoute Sign-in Helper",
  version: "0.1.0",
  description: "Completes OmniRoute OAuth sign-ins on remote dashboards without copy-paste.",
  // No scripting, activeTab or per-dashboard host permission: the dashboard talks to the
  // extension through the bridge.html frame, and approval is a stored list.
  permissions: ["declarativeNetRequest", "storage", "webNavigation", "alarms"],
  host_permissions: [],
  background: { service_worker: "src/background.js", type: "module" },
  action: { default_title: "OmniRoute Sign-in Helper", default_popup: "src/popup.html" },
  web_accessible_resources: WEB_ACCESSIBLE_RESOURCES,
  content_security_policy: CONTENT_SECURITY_POLICY,
  minimum_chrome_version: "120",
  key: MANIFEST_KEY,
};

const supported = () => EXTERNAL_REDIRECTS.filter((e) => e.bridge === "supported");

export function buildManifest(existing) {
  const base = existing && typeof existing === "object" ? existing : BASE_MANIFEST;
  const hostPermissions = [...new Set(supported().map((e) => e.hostPermission))].sort();
  // permissions, web_accessible_resources, content_security_policy and key always come from
  // BASE_MANIFEST so a change here reaches the checked-in file.
  // optional_host_permissions came with the old content-script design; drop it from older files.
  const { optional_host_permissions: _dropped, ...rest } = base;
  return (
    JSON.stringify(
      {
        ...rest,
        permissions: BASE_MANIFEST.permissions,
        host_permissions: hostPermissions,
        web_accessible_resources: BASE_MANIFEST.web_accessible_resources,
        content_security_policy: BASE_MANIFEST.content_security_policy,
        minimum_chrome_version: BASE_MANIFEST.minimum_chrome_version,
        key: BASE_MANIFEST.key,
      },
      null,
      2
    ) + "\n"
  );
}

async function format(src, file) {
  const config = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(src, { ...config, filepath: file });
}

export async function buildAllowedRedirectsSource() {
  const items = supported()
    .map((e) => {
      // stateMode / requiredParams are emitted only when set, so plain entries stay unchanged.
      const extra =
        (e.stateMode !== undefined ? `, stateMode: ${JSON.stringify(e.stateMode)}` : "") +
        (e.requiredParams !== undefined
          ? `, requiredParams: Object.freeze(${JSON.stringify(e.requiredParams)})`
          : "");
      return `  Object.freeze({ provider: ${JSON.stringify(e.provider)}, kind: ${JSON.stringify(
        e.kind
      )}, redirectUri: ${JSON.stringify(e.redirectUri)}${extra} }),`;
    })
    .join("\n");
  const src =
    "// GENERATED by scripts/build/oauth-bridge-manifest.mjs from src/lib/oauth/externalRedirects.ts. " +
    "Do not edit; run npm run oauth-bridge:build.\n" +
    `export const ALLOWED_REDIRECTS = Object.freeze([\n${items}\n]);\n`;
  return format(src, ALLOWED_PATH);
}

export const README_START = "<!-- oauth-bridge:providers:start -->";
export const README_END = "<!-- oauth-bridge:providers:end -->";

export function buildReadmeSection() {
  const rows = supported().map(
    (e) => `| \`${e.provider}\` | ${e.kind} | \`${e.redirectUri}\` | ${e.phase} |`
  );
  const unsupported = EXTERNAL_REDIRECTS.filter((e) => e.bridge === "unsupported").map(
    (e) => `- \`${e.provider}\`: ${e.notes ?? "not supported."}`
  );
  return [
    "| Provider | Kind | Redirect URI | Phase |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "`{port}` is the dashboard's own port.",
    "",
    "Unsupported:",
    "",
    ...unsupported,
  ].join("\n");
}

export async function spliceReadme(readme) {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md is missing the ${README_START} / ${README_END} markers`);
  }
  const next =
    readme.slice(0, start + README_START.length) +
    "\n\n" +
    buildReadmeSection() +
    "\n\n" +
    readme.slice(end);
  return format(next, README_PATH);
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function firstDiff(expected, actual) {
  const e = expected.split("\n");
  const a = (actual ?? "").split("\n");
  const out = [];
  for (let i = 0; i < Math.max(e.length, a.length) && out.length < 20; i++) {
    if (e[i] !== a[i]) {
      if (e[i] !== undefined) out.push(`- ${e[i]}`);
      if (a[i] !== undefined) out.push(`+ ${a[i]}`);
    }
  }
  return out.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const current = readIfExists(MANIFEST_PATH);
  const outputs = [
    [
      MANIFEST_PATH,
      await format(buildManifest(current ? JSON.parse(current) : null), MANIFEST_PATH),
    ],
    [ALLOWED_PATH, await buildAllowedRedirectsSource()],
    [README_PATH, await spliceReadme(readIfExists(README_PATH) ?? "")],
  ];
  const stale = [];
  for (const [file, content] of outputs) {
    const actual = readIfExists(file);
    if (actual === content) continue;
    stale.push(file);
    const rel = path.relative(ROOT, file);
    if (check) {
      console.error(
        `oauth-bridge: ${rel} is stale (- expected, + actual)\n${firstDiff(content, actual)}`
      );
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      console.log(`oauth-bridge: updated ${rel}`);
    }
  }
  if (check) {
    if (stale.length) {
      console.error("Run npm run oauth-bridge:build");
      return 1;
    }
    console.log("oauth-bridge: manifest and allow-list are up to date");
  } else if (!stale.length) {
    console.log("oauth-bridge: nothing to update");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
