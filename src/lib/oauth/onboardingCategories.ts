/**
 * Onboarding category for every OAuth provider: how a user signs in and whether the
 * OmniRoute sign-in helper (browser extension) is involved.
 *
 * Derived, not hand-maintained: the provider's `flowType` (src/lib/oauth/providers) plus
 * the redirect registry (externalRedirects.ts). `tests/unit/oauth-provider-classification.test.ts`
 * fails when a provider cannot be classified; `npm run oauth:categories` prints the table.
 *
 * Server-side module (imports the provider index). Client components read
 * externalRedirects.ts directly.
 */

import {
  DASHBOARD_ORIGIN_REDIRECT_PROVIDERS,
  EXTERNAL_REDIRECTS,
  getExternalRedirect,
  type ExternalRedirectKind,
} from "./externalRedirects";
import { PROVIDERS } from "./providers/index";

export const OAUTH_ONBOARDING_CATEGORIES = [
  "bridge-fixed-loopback",
  "bridge-dashboard-port-loopback",
  "bridge-provider-code-page",
  "dashboard-origin-callback",
  "device-code",
  "import-token",
  "manual-only",
] as const;

export type OAuthOnboardingCategory = (typeof OAUTH_ONBOARDING_CATEGORIES)[number];

export interface OAuthProviderClassification {
  provider: string;
  /** flowType from src/lib/oauth/providers, or "registry-only" (chatgpt). */
  flowType: string;
  category: OAuthOnboardingCategory;
  /** Registry redirect URI ("{port}" kept), when the provider has one. */
  redirectUri?: string;
  reason: string;
}

const BRIDGE_CATEGORY_BY_KIND: Record<ExternalRedirectKind, OAuthOnboardingCategory> = {
  "fixed-loopback": "bridge-fixed-loopback",
  "dashboard-port-loopback": "bridge-dashboard-port-loopback",
  "provider-code-page": "bridge-provider-code-page",
};

const BRIDGE_REASON_BY_KIND: Record<ExternalRedirectKind, string> = {
  "fixed-loopback": "Redirects to a fixed loopback port; the sign-in helper carries it back.",
  "dashboard-port-loopback":
    "Redirects to a loopback on the dashboard port; the sign-in helper carries it back.",
  "provider-code-page":
    "Provider page shows the code; the sign-in helper carries it back instead of a paste.",
};

const AUTHORIZATION_CODE_FLOWS = new Set(["authorization_code", "authorization_code_pkce"]);

type ProviderModule = { flowType?: string };

/** Every provider id: the oauth provider index plus registry-only entries (chatgpt). */
export function listOAuthProviderIds(): string[] {
  const ids = new Set<string>(Object.keys(PROVIDERS));
  for (const entry of EXTERNAL_REDIRECTS) ids.add(entry.provider);
  for (const id of DASHBOARD_ORIGIN_REDIRECT_PROVIDERS) ids.add(id);
  return [...ids].sort();
}

export function getOAuthProviderFlowType(id: string): string | undefined {
  return (PROVIDERS as Record<string, ProviderModule>)[id]?.flowType;
}

export function isAuthorizationCodeFlow(flowType: string | undefined): boolean {
  return flowType !== undefined && AUTHORIZATION_CODE_FLOWS.has(flowType);
}

/**
 * Category precedence: a bridge-supported registry entry wins (devin-desktop and grok-cli
 * have a browser PKCE tab next to their primary import/device flow); then the
 * dashboard-origin list; then device_code / import_token flowType; then a registry entry
 * marked unsupported (manual paste). Returns undefined for an unknown or unclassifiable id.
 */
export function classifyOAuthProvider(id: string): OAuthProviderClassification | undefined {
  const flowType = getOAuthProviderFlowType(id);
  const entry = getExternalRedirect(id);
  if (!flowType && !entry && !DASHBOARD_ORIGIN_REDIRECT_PROVIDERS.includes(id)) return undefined;
  const base = { provider: id, flowType: flowType ?? "registry-only" };

  if (entry?.bridge === "supported") {
    return {
      ...base,
      category: BRIDGE_CATEGORY_BY_KIND[entry.kind],
      redirectUri: entry.redirectUri,
      reason: BRIDGE_REASON_BY_KIND[entry.kind],
    };
  }
  if (DASHBOARD_ORIGIN_REDIRECT_PROVIDERS.includes(id)) {
    return {
      ...base,
      category: "dashboard-origin-callback",
      reason: "Redirect lands on the dashboard origin itself; no helper needed.",
    };
  }
  if (flowType === "device_code") {
    return {
      ...base,
      category: "device-code",
      reason: "User enters a code on the provider site; the dashboard polls, nothing to paste.",
    };
  }
  if (flowType === "import_token") {
    return {
      ...base,
      category: "import-token",
      redirectUri: entry?.redirectUri,
      reason: "User imports a token or credential file; no browser redirect.",
    };
  }
  if (entry) {
    return {
      ...base,
      category: "manual-only",
      redirectUri: entry.redirectUri,
      reason: entry.notes ?? "Registry marks the bridge unsupported; manual URL paste.",
    };
  }
  return undefined;
}

export function classifyAllOAuthProviders(): OAuthProviderClassification[] {
  return listOAuthProviderIds().flatMap((id) => {
    const result = classifyOAuthProvider(id);
    return result ? [result] : [];
  });
}
