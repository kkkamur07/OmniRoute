/**
 * Single source of truth for every OAuth provider whose consent redirect does NOT land
 * on the OmniRoute dashboard origin.
 *
 * These providers' OAuth apps are registered with either a fixed loopback URL
 * (codex -> http://localhost:1455/auth/callback), a loopback on the dashboard's own port
 * (Google native-app credentials), or a provider-hosted page that shows a code
 * (claude). A dashboard reached remotely cannot receive those redirects, so a browser
 * extension (or the operator, by pasting the URL) has to carry them back.
 *
 * Browser-safe on purpose: no server-only imports. OAuthModal (client component),
 * pkceLoopbackWarning / googleLoopbackHint and Node build scripts all read it.
 * `tests/unit/oauth-external-redirects.test.ts` fails when an authorization-code
 * provider is missing from both this list and DASHBOARD_ORIGIN_REDIRECT_PROVIDERS.
 */

export type ExternalRedirectKind =
  "fixed-loopback" | "dashboard-port-loopback" | "provider-code-page";

export interface ExternalRedirectEntry {
  /** OmniRoute provider id. */
  provider: string;
  kind: ExternalRedirectKind;
  /** Exact URI; "{port}" placeholder for dashboard-port-loopback. */
  redirectUri: string;
  /** Chrome match pattern covering redirectUri, e.g. "http://localhost/*". */
  hostPermission: string;
  /** Can a browser extension complete it by redirecting the tab. */
  bridge: "supported" | "unsupported";
  /** major = codex, openai, claude, xai-oauth, grok-cli. */
  phase: "major" | "later";
  notes?: string;
}

const PORT_PLACEHOLDER = "{port}";

export const EXTERNAL_REDIRECTS: readonly ExternalRedirectEntry[] = [
  {
    provider: "codex",
    kind: "fixed-loopback",
    redirectUri: "http://localhost:1455/auth/callback",
    hostPermission: "http://localhost/*",
    bridge: "supported",
    phase: "major",
    notes: "Port registered in the Codex CLI OAuth app; PKCE callback server on true localhost.",
  },
  {
    provider: "openai",
    kind: "fixed-loopback",
    redirectUri: "http://localhost:1455/auth/callback",
    hostPermission: "http://localhost/*",
    bridge: "supported",
    phase: "major",
    notes: "Alias of codex in OAuthModal; no callback server of its own.",
  },
  {
    provider: "claude",
    kind: "provider-code-page",
    redirectUri: "https://platform.claude.com/oauth/code/callback",
    hostPermission: "https://platform.claude.com/*",
    bridge: "supported",
    phase: "major",
    notes:
      "CLAUDE_CODE_OAUTH_CONFIG.redirectUri default; overridable via CLAUDE_CODE_REDIRECT_URI.",
  },
  {
    provider: "xai-oauth",
    kind: "fixed-loopback",
    redirectUri: "http://127.0.0.1:56121/callback",
    hostPermission: "http://127.0.0.1/*",
    bridge: "supported",
    phase: "major",
    notes: "Distinct from grok-cli's port so both can run concurrently (#7013).",
  },
  {
    provider: "grok-cli",
    kind: "fixed-loopback",
    redirectUri: "http://127.0.0.1:56122/callback",
    hostPermission: "http://127.0.0.1/*",
    bridge: "supported",
    phase: "major",
    notes: "Browser PKCE login only; the default grok-cli flow is device code.",
  },
  {
    provider: "devin-desktop",
    kind: "fixed-loopback",
    redirectUri: "http://127.0.0.1:59653/callback",
    hostPermission: "http://127.0.0.1/*",
    bridge: "supported",
    phase: "later",
    notes:
      "Loopback registered by the Devin CLI login (DEVIN_DESKTOP_CONFIG.callbackPort). " +
      "Browser PKCE tab: state is sent and checked on paste; code + client-held verifier " +
      "suffice for the exchange.",
  },
  {
    provider: "chatgpt",
    kind: "fixed-loopback",
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    hostPermission: "http://127.0.0.1/*",
    bridge: "supported",
    phase: "later",
    notes: "ChatGptOAuthModal + chatgptProtocol.ts; not in the oauth providers index.",
  },
  {
    provider: "copilot-m365-web",
    kind: "provider-code-page",
    redirectUri: "https://login.microsoftonline.com/common/oauth2/nativeclient",
    hostPermission: "https://login.microsoftonline.com/*",
    bridge: "supported",
    phase: "later",
    notes: "M365_NATIVE_REDIRECT_URI; handled by M365OAuthModal.",
  },
  {
    provider: "devin-cli",
    kind: "dashboard-port-loopback",
    redirectUri: "http://localhost:{port}/auth/callback",
    hostPermission: "http://localhost/*",
    bridge: "unsupported",
    phase: "later",
    notes:
      "Import-token only: the browser authorize flow is retired (authorize returns 410) and " +
      "OAuthModal never starts it, so there is no redirect for the extension to catch.",
  },
  {
    provider: "antigravity",
    kind: "dashboard-port-loopback",
    redirectUri: "http://127.0.0.1:{port}/callback",
    hostPermission: "http://127.0.0.1/*",
    bridge: "unsupported",
    phase: "later",
    notes:
      "Google firstparty/nativeapp consent hangs without a live loopback listener, so there " +
      "is no redirect to catch (see googleLoopbackHint.ts).",
  },
  {
    provider: "agy",
    kind: "dashboard-port-loopback",
    redirectUri: "http://127.0.0.1:{port}/callback",
    hostPermission: "http://127.0.0.1/*",
    bridge: "unsupported",
    phase: "later",
    notes: "Same Google native-app consent as antigravity; hangs without a loopback listener.",
  },
  {
    provider: "renderhour",
    kind: "dashboard-port-loopback",
    redirectUri: "http://localhost:{port}/callback",
    hostPermission: "http://localhost/*",
    bridge: "supported",
    phase: "later",
    notes:
      "Loopback-only OAuth server (RFC 8252). On true localhost OAuthModal keeps the " +
      "browser's own hostname (localhost or 127.0.0.1); remote dashboards use localhost " +
      "with the dashboard port (20128 when the URL has none). Code + state + PKCE suffice.",
  },
  {
    provider: "zed-hosted",
    kind: "dashboard-port-loopback",
    redirectUri: "http://127.0.0.1:{port}/",
    hostPermission: "http://127.0.0.1/*",
    bridge: "unsupported",
    phase: "later",
    notes:
      "Zed native_app_signin sends no OAuth state (zedAuth.ts createZedNativeAuthData) and " +
      "redirects to http://127.0.0.1:<native_app_port>/?user_id&access_token (an " +
      "RSA-encrypted token, not code/state). The bridge rule is state-keyed, so remote " +
      "sign-in uses manual URL paste.",
  },
];

/** authorization_code providers whose redirect lands on the dashboard origin itself. */
export const DASHBOARD_ORIGIN_REDIRECT_PROVIDERS: readonly string[] = [
  "qoder",
  "gitlab-duo",
  "cline",
  "clinepass",
  "openference",
];

export function getExternalRedirect(provider: string): ExternalRedirectEntry | undefined {
  return EXTERNAL_REDIRECTS.find((entry) => entry.provider === provider);
}

/** The exact redirect URI for `provider`, with "{port}" filled from `dashboardPort`. */
export function resolveExternalRedirectUri(
  provider: string,
  dashboardPort: string
): string | undefined {
  return getExternalRedirect(provider)?.redirectUri.replace(PORT_PLACEHOLDER, dashboardPort);
}

/** Fixed callback port inside the entry's URI; null for "{port}" entries and https pages. */
export function callbackPortOf(entry: ExternalRedirectEntry): number | null {
  if (entry.redirectUri.includes(PORT_PLACEHOLDER)) return null;
  const url = new URL(entry.redirectUri);
  return url.protocol === "http:" && url.port ? Number(url.port) : null;
}
