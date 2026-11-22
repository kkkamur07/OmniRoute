import { CLINE_CONFIG } from "../constants/oauth";

/**
 * Cline's authorize endpoint takes no `state` parameter (the upstream client never sends one),
 * so the attempt state rides inside the callback URL itself: `<origin>/callback?state=<state>`.
 * Cline appends its `code` to that URL, the callback page reads `state` back from the query,
 * and the dashboard's state check passes. The exchange rebuilds the same URL so the
 * `redirect_uri` it sends matches the one given at authorize time.
 */
export function withClineCallbackState(redirectUri: string, state?: string | null): string {
  if (!state) return redirectUri;
  try {
    const url = new URL(redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  } catch {
    const separator = redirectUri.includes("?") ? "&" : "?";
    return `${redirectUri}${separator}state=${encodeURIComponent(state)}`;
  }
}

export const cline = {
  config: CLINE_CONFIG,
  flowType: "authorization_code",
  buildAuthUrl: (config, redirectUri, state?: string) => {
    const callbackUrl = withClineCallbackState(redirectUri, state);
    const params = new URLSearchParams({
      client_type: "extension",
      callback_url: callbackUrl,
      redirect_uri: callbackUrl,
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, _codeVerifier?: string, state?: string) => {
    try {
      // Cline embeds tokens as base64-encoded JSON in the auth code.
      // The code may be URL-encoded when pasted from the callback URL.
      let base64 = code;
      try {
        base64 = decodeURIComponent(base64);
      } catch {
        /* already decoded */
      }
      const padding = 4 - (base64.length % 4);
      if (padding !== 4) {
        base64 += "=".repeat(padding);
      }
      const decoded = Buffer.from(base64, "base64").toString("utf-8");
      const lastBrace = decoded.lastIndexOf("}");
      if (lastBrace === -1) {
        throw new Error("No JSON found in decoded code");
      }
      const jsonStr = decoded.substring(0, lastBrace + 1);
      const tokenData = JSON.parse(jsonStr);
      return {
        access_token: tokenData.accessToken,
        refresh_token: tokenData.refreshToken,
        email: tokenData.email,
        firstName: tokenData.firstName,
        lastName: tokenData.lastName,
        expires_at: tokenData.expiresAt,
      };
    } catch (e) {
      const response = await fetch(config.tokenExchangeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: code,
          client_type: "extension",
          redirect_uri: withClineCallbackState(redirectUri, state),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Cline token exchange failed: ${error}`);
      }

      const data = await response.json();
      return {
        access_token: data.data?.accessToken || data.accessToken,
        refresh_token: data.data?.refreshToken || data.refreshToken,
        email: data.data?.userInfo?.email || "",
        expires_at: data.data?.expiresAt || data.expiresAt,
      };
    }
  },
  mapTokens: (tokens) => {
    const firstName = tokens.firstName || "";
    const lastName = tokens.lastName || "";
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_at
        ? Math.floor((new Date(tokens.expires_at).getTime() - Date.now()) / 1000)
        : 3600,
      // Use full name if available, fallback to email so UI shows a real label
      name: fullName || tokens.email || null,
      email: tokens.email,
      providerSpecificData: {
        firstName: tokens.firstName,
        lastName: tokens.lastName,
      },
    };
  },
};
