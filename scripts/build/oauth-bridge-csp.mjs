/**
 * oauth-bridge-csp.mjs: the Content-Security-Policy `frame-src` directive that lets the
 * dashboard embed the OmniRoute Sign-in Helper's hidden bridge frame
 * (`chrome-extension://<id>/bridge.html`, see src/shared/components/oauthModal/helperExtension.ts).
 *
 * Imported by next.config.mjs, so it stays dependency-free plain JS. The default ID is the one
 * pinned by the manifest key (EXTENSION_ID in scripts/build/oauth-bridge-manifest.mjs);
 * NEXT_PUBLIC_OAUTH_HELPER_EXTENSION_ID overrides it, exactly like the dashboard does.
 */

export const DEFAULT_OAUTH_HELPER_EXTENSION_ID = "gmckjokkoeeokoldknjmaipdbnceldil";

const EXTENSION_ID_RE = /^[a-p]{32}$/;

/** The helper extension ID for `env` (a valid override, else the default). */
export function oauthHelperExtensionId(env = process.env) {
  const override = String(env?.NEXT_PUBLIC_OAUTH_HELPER_EXTENSION_ID || "").trim();
  return EXTENSION_ID_RE.test(override) ? override : DEFAULT_OAUTH_HELPER_EXTENSION_ID;
}

/** `frame-src 'self' chrome-extension://<id>` for the configured helper extension. */
export function oauthHelperFrameSrc(env = process.env) {
  return `frame-src 'self' chrome-extension://${oauthHelperExtensionId(env)}`;
}
