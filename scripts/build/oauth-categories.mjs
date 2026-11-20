#!/usr/bin/env node
/**
 * Print the onboarding category of every OAuth provider, grouped by category.
 * Run: npm run oauth:categories (node --import tsx/esm).
 * Source of truth: src/lib/oauth/onboardingCategories.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The provider index pulls in modules that open the SQLite DB on import. Point DATA_DIR at a
// throwaway directory so printing the table never migrates the operator's real data dir.
const scratchDataDir = mkdtempSync(join(tmpdir(), "omniroute-oauth-categories-"));
process.env.DATA_DIR = scratchDataDir;
process.on("exit", () => rmSync(scratchDataDir, { recursive: true, force: true }));

// Importing the provider index opens and migrates the scratch DB, which prints a few hundred
// "[DB]" / "[Migration]" lines through plain console.log/info/debug/warn (src/lib/db/core.ts,
// src/lib/db/migrationRunner.ts; no log-level switch gates them). Mute those methods for the
// import only; console.error stays live so a real failure is still visible.
const MUTED = ["log", "info", "debug", "warn"];
const originals = MUTED.map((method) => [method, console[method]]);
for (const method of MUTED) console[method] = () => {};
let imported;
try {
  imported = await import("../../src/lib/oauth/onboardingCategories.ts");
} finally {
  for (const [method, fn] of originals) console[method] = fn;
}
const { OAUTH_ONBOARDING_CATEGORIES, classifyAllOAuthProviders, listOAuthProviderIds } = imported;

const rows = classifyAllOAuthProviders();
const unclassified = listOAuthProviderIds().filter((id) => !rows.some((r) => r.provider === id));

const pad = (value, width) => String(value).padEnd(width);
const widths = {
  provider: Math.max(8, ...rows.map((r) => r.provider.length)),
  flowType: Math.max(8, ...rows.map((r) => r.flowType.length)),
  redirect: Math.max(8, ...rows.map((r) => (r.redirectUri ?? "-").length)),
};

// `| head` closes stdout early; exit quietly instead of crashing on EPIPE.
process.stdout.on("error", (err) => {
  if (err?.code === "EPIPE") process.exit(0);
  throw err;
});

OAUTH_ONBOARDING_CATEGORIES.forEach((category, index) => {
  const group = rows.filter((r) => r.category === category);
  console.log(`${index === 0 ? "" : "\n"}## ${category} (${group.length})`);
  if (group.length === 0) return;
  console.log(
    `${pad("provider", widths.provider)}  ${pad("flowType", widths.flowType)}  ` +
      `${pad("redirect", widths.redirect)}  reason`
  );
  for (const r of group) {
    console.log(
      `${pad(r.provider, widths.provider)}  ${pad(r.flowType, widths.flowType)}  ` +
        `${pad(r.redirectUri ?? "-", widths.redirect)}  ${r.reason}`
    );
  }
});

console.log("\nCounts:");
for (const category of OAUTH_ONBOARDING_CATEGORIES) {
  console.log(`  ${pad(category, 32)} ${rows.filter((r) => r.category === category).length}`);
}
console.log(`  ${pad("total", 32)} ${rows.length}`);

if (unclassified.length > 0) {
  console.error(`\nUnclassified providers: ${unclassified.join(", ")}`);
  process.exit(1);
}
