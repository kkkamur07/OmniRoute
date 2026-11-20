"use client";

/**
 * Dashboard side of the OmniRoute Sign-in Helper (OAuth bridge) browser extension.
 *
 * Wire protocol (window.postMessage, targetOrigin = location.origin, both directions):
 * - extension -> page: `{source: "omniroute-oauth-bridge", type: "ready", version}`; the
 *   extension also sets `document.documentElement.dataset.omnirouteOauthBridge = version`.
 * - page -> extension: `{source: "omniroute-dashboard", type: "oauth-bridge:arm", requestId,
 *   provider, state, redirectUri}`.
 * - extension -> page: `{source: "omniroute-oauth-bridge", type: "oauth-bridge:armed" |
 *   "oauth-bridge:error", requestId, reason?}`.
 *
 * Once armed, the provider's redirect for that state is sent to `<origin>/callback?<query>`
 * and src/app/callback/page.tsx relays code/state to the open OAuthModal as usual.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getExternalRedirect } from "@/lib/oauth/externalRedirects";

export const BRIDGE_SOURCE = "omniroute-oauth-bridge";
export const DASHBOARD_SOURCE = "omniroute-dashboard";
export const BRIDGE_ARM_TIMEOUT_MS = 1500;
/** Registry phases the dashboard bridges (phase B enabled "later"); the one place to gate. */
export const BRIDGE_ENABLED_PHASES = ["major", "later"] as const;

/** Docs section the "install the helper" hint links to. */
export const BRIDGE_DOCS_URL =
  "https://github.com/cheaper-inference/OmniRoute/blob/main/docs/guides/REMOTE-MODE.md#sign-in-helper-extension";

/** The subset of MessageEvent the guards read (keeps them testable without a DOM). */
export type BridgeMessageEvent = { source: unknown; origin: string; data: unknown };
export type BridgeLocation = { origin: string };
/** The `window` the message must come from; defaults to the global window. */
export type BridgeWindowRef = unknown;

export type BridgeArmRequest = { provider: string; state: string; redirectUri: string };

function bridgeData(
  event: BridgeMessageEvent,
  location: BridgeLocation,
  self: BridgeWindowRef
): Record<string, unknown> | null {
  if (!event || event.source !== self || event.origin !== location.origin) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  return record.source === BRIDGE_SOURCE ? record : null;
}

function currentWindow(): BridgeWindowRef {
  return typeof window === "undefined" ? undefined : window;
}

/** A `ready` announcement from the extension's content script in this same page. */
export function isBridgeReadyMessage(
  event: BridgeMessageEvent,
  location: BridgeLocation,
  self: BridgeWindowRef = currentWindow()
): boolean {
  const data = bridgeData(event, location, self);
  return !!data && data.type === "ready";
}

/** An `armed` / `error` reply to the arm request `requestId`. */
export function isBridgeReplyMessage(
  event: BridgeMessageEvent,
  location: BridgeLocation,
  requestId: string,
  self: BridgeWindowRef = currentWindow()
): boolean {
  const data = bridgeData(event, location, self);
  return (
    !!data &&
    !!requestId &&
    data.requestId === requestId &&
    (data.type === "oauth-bridge:armed" || data.type === "oauth-bridge:error")
  );
}

/** True when the registry marks the provider bridge-supported in an enabled phase. */
export function isBridgeSupportedProvider(provider: string | undefined): boolean {
  const entry = provider ? getExternalRedirect(provider) : undefined;
  return (
    !!entry &&
    entry.bridge === "supported" &&
    (BRIDGE_ENABLED_PHASES as readonly string[]).includes(entry.phase)
  );
}

/** Use the bridge only off true-localhost, with the extension present, for supported providers. */
export function shouldUseBridge(opts: {
  provider: string | undefined;
  isTrueLocalhost: boolean;
  bridgeVersion: string | null | undefined;
}): boolean {
  return !opts.isTrueLocalhost && !!opts.bridgeVersion && isBridgeSupportedProvider(opts.provider);
}

/** Show the one-line install hint: supported provider, remote location, no extension. */
export function shouldShowBridgeHint(opts: {
  provider: string | undefined;
  isTrueLocalhost: boolean;
  bridgeVersion: string | null | undefined;
}): boolean {
  return !opts.isTrueLocalhost && !opts.bridgeVersion && isBridgeSupportedProvider(opts.provider);
}

export function newBridgeRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Detects the extension and arms it for one OAuth attempt.
 * `arm` resolves true on `armed`, false on `error` or after BRIDGE_ARM_TIMEOUT_MS.
 */
export function useOAuthBridge(): {
  bridgeVersion: string | null;
  arm: (req: BridgeArmRequest) => Promise<boolean>;
} {
  const [bridgeVersion, setBridgeVersion] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    // Read the dataset marker after mount (deferred so hydration matches the server render).
    const initialTimer = setTimeout(() => {
      const datasetVersion = document.documentElement?.dataset?.omnirouteOauthBridge;
      if (datasetVersion) setBridgeVersion((prev) => prev ?? datasetVersion);
    }, 0);

    const onMessage = (event: MessageEvent) => {
      if (!isBridgeReadyMessage(event, window.location)) return;
      const version = (event.data as Record<string, unknown>).version;
      const fallback = document.documentElement?.dataset?.omnirouteOauthBridge || "1";
      setBridgeVersion(version !== undefined && version !== null ? String(version) : fallback);
    };
    window.addEventListener("message", onMessage);
    return () => {
      clearTimeout(initialTimer);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  const arm = useCallback((req: BridgeArmRequest): Promise<boolean> => {
    if (typeof window === "undefined") return Promise.resolve(false);
    const { provider, state, redirectUri } = req || ({} as BridgeArmRequest);
    if (!provider || !state || !redirectUri) return Promise.resolve(false);

    const requestId = newBridgeRequestId();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };

      function onMessage(event: MessageEvent) {
        if (!isBridgeReplyMessage(event, window.location, requestId)) return;
        const type = (event.data as Record<string, unknown>).type;
        if (type === "oauth-bridge:armed") finish(true);
        else if (type === "oauth-bridge:error") finish(false);
      }

      window.addEventListener("message", onMessage);
      timer = setTimeout(() => finish(false), BRIDGE_ARM_TIMEOUT_MS);

      try {
        window.postMessage(
          {
            source: DASHBOARD_SOURCE,
            type: "oauth-bridge:arm",
            requestId,
            provider,
            state,
            redirectUri,
          },
          window.location.origin
        );
      } catch {
        finish(false);
      }
    });
  }, []);

  return { bridgeVersion, arm };
}

/** True when the dashboard is open on the operator's own machine (no bridge needed). */
export function isTrueLocalhostHost(hostname: string | undefined): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** Payload src/app/callback/page.tsx relays (postMessage data / BroadcastChannel / localStorage). */
export type OAuthCallbackRelay = {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  fullUrl?: string;
};

export const CALLBACK_RELAY_KEY = "oauth_callback";
/** A stored relay older than this is stale (a previous attempt) and is ignored. */
export const CALLBACK_RELAY_MAX_AGE_MS = 30_000;

/** The relay payload when it belongs to `state`, else null (other flows share the channel). */
export function relayForState(
  raw: unknown,
  state: string | null | undefined
): OAuthCallbackRelay | null {
  if (!state || !raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (data.state !== state) return null;
  const str = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    code: str(data.code),
    state,
    error: str(data.error),
    fullUrl: typeof data.fullUrl === "string" ? data.fullUrl : undefined,
  };
}

/** A stored (localStorage) relay for `state` that is still fresh, else null. */
export function storedRelayForState(
  raw: string | null,
  state: string | null | undefined,
  now: number = Date.now()
): OAuthCallbackRelay | null {
  try {
    const data = raw ? JSON.parse(raw) : null;
    const timestamp = typeof data?.timestamp === "number" ? data.timestamp : 0;
    if (now - timestamp > CALLBACK_RELAY_MAX_AGE_MS) return null;
    return relayForState(data, state);
  } catch {
    return null;
  }
}

/** One query parameter of the relayed `fullUrl` (e.g. ChatGPT's client_id), if present. */
export function relayedParam(fullUrl: string | undefined, key: string): string | undefined {
  try {
    return new URL(fullUrl || "").searchParams.get(key) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Listens for the /callback relay (same-origin postMessage, BroadcastChannel, storage) and calls
 * `onCallback` once with the payload whose state equals `state`. Inactive while `state` is empty.
 */
export function useOAuthCallbackRelay(
  state: string | null | undefined,
  onCallback: (relay: OAuthCallbackRelay) => void
): void {
  const handlerRef = useRef(onCallback);
  useEffect(() => {
    handlerRef.current = onCallback;
  });

  useEffect(() => {
    if (!state || typeof window === "undefined") return undefined;
    let handled = false;
    const deliver = (relay: OAuthCallbackRelay | null) => {
      if (handled || !relay) return;
      handled = true;
      try {
        localStorage.removeItem(CALLBACK_RELAY_KEY);
      } catch {
        // Storage unavailable: nothing to clean up.
      }
      handlerRef.current(relay);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== CALLBACK_RELAY_KEY)
        return;
      deliver(relayForState(event.data.data, state));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === CALLBACK_RELAY_KEY) deliver(storedRelayForState(event.newValue, state));
    };
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CALLBACK_RELAY_KEY);
      channel.onmessage = (event) => deliver(relayForState(event.data, state));
    } catch {
      channel = null;
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    try {
      deliver(storedRelayForState(localStorage.getItem(CALLBACK_RELAY_KEY), state));
    } catch {
      // Storage unavailable: the other channels and the paste fallback still work.
    }
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
      channel?.close();
    };
  }, [state]);
}
