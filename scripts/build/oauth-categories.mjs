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

// Keep import-time DB logs off stdout so the table is the only output there.
const originalLog = console.log;
console.log = (...args) => console.error(...args);
const { OAUTH_ONBOARDING_CATEGORIES, classifyAllOAuthProviders, listOAuthProviderIds } =
  await import("../../src/lib/oauth/onboardingCategories.ts");
console.log = originalLog;

const rows = classifyAllOAuthProviders();
const unclassified = listOAuthProviderIds().filter((id) => !rows.some((r) => r.provider === id));

const pad = (value, width) => String(value).padEnd(width);
const widths = {
  provider: Math.max(8, ...rows.map((r) => r.provider.length)),
  flowType: Math.max(8, ...rows.map((r) => r.flowType.length)),
  redirect: Math.max(8, ...rows.map((r) => (r.redirectUri ?? "-").length)),
};

for (const category of OAUTH_ONBOARDING_CATEGORIES) {
  const group = rows.filter((r) => r.category === category);
  console.log(`\n## ${category} (${group.length})`);
  if (group.length === 0) continue;
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
}

console.log("\nCounts:");
for (const category of OAUTH_ONBOARDING_CATEGORIES) {
  console.log(`  ${pad(category, 32)} ${rows.filter((r) => r.category === category).length}`);
}
console.log(`  ${pad("total", 32)} ${rows.length}`);

if (unclassified.length > 0) {
  console.error(`\nUnclassified providers: ${unclassified.join(", ")}`);
  process.exit(1);
}
