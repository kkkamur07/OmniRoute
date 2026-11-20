"use client";

/**
 * Dashboard side of the OmniRoute Sign-in Helper (OAuth bridge) browser extension.
 *
 * While a Connect dialog is open the page holds one hidden iframe,
 * `chrome-extension://<id>/bridge.html` (BridgeFrame in helperExtension.ts), and talks to it with
 * postMessage only (targetOrigin = the extension origin; replies are accepted only from that
 * iframe's window and origin):
 * - bridge -> page: `{source: "omniroute-oauth-bridge", type: "ready", version, approved}`, and
 *   `{type: "approved", version}` once the operator allows this dashboard.
 * - page -> bridge: `{source: "omniroute-dashboard", type: "oauth-bridge:arm", requestId,
 *   provider, state, redirectUri}`.
 * - bridge -> page: `{source: "omniroute-oauth-bridge", type: "oauth-bridge:armed" |
 *   "oauth-bridge:error", requestId, reason?}`.
 *
 * Once armed, the provider's redirect for that state is sent to `<origin>/callback?<query>`
 * and src/app/callback/page.tsx relays code/state to the open OAuthModal as usual.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { getExternalRedirect } from "@/lib/oauth/externalRedirects";
import {
  BRIDGE_ARM_TIMEOUT_MS,
  BRIDGE_SOURCE,
  DASHBOARD_SOURCE,
  bridgeFrameData,
  getBridgeFrame,
  type BridgeArmRequest,
  type BridgeMessageEvent,
  type BridgeSnapshot,
} from "./helperExtension";

export { BRIDGE_ARM_TIMEOUT_MS, BRIDGE_SOURCE, DASHBOARD_SOURCE };
export type { BridgeArmRequest, BridgeMessageEvent };

/** Registry phases the dashboard bridges (phase B enabled "later"); the one place to gate. */
export const BRIDGE_ENABLED_PHASES = ["major", "later"] as const;

/** Docs section the "install the helper" hint links to. */
export const BRIDGE_DOCS_URL =
  "https://github.com/cheaper-inference/OmniRoute/blob/main/docs/guides/REMOTE-MODE.md#sign-in-helper-extension";

/** A `ready` announcement from the bridge frame (`frameWindow`) on the extension origin. */
export function isBridgeReadyMessage(
  event: BridgeMessageEvent,
  frameWindow: unknown,
  extensionOrigin: string
): boolean {
  const data = bridgeFrameData(event, frameWindow, extensionOrigin);
  return !!data && data.type === "ready";
}

/** An `armed` / `error` reply from the bridge frame to the arm request `requestId`. */
export function isBridgeReplyMessage(
  event: BridgeMessageEvent,
  frameWindow: unknown,
  extensionOrigin: string,
  requestId: string
): boolean {
  const data = bridgeFrameData(event, frameWindow, extensionOrigin);
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

/**
 * The one bridge gate for every sign-in dialog: extension present and provider
 * bridge-supported, on any host (true localhost included). The extension intercepts the
 * loopback redirect before any network request, so it works for npm-local and Docker-local
 * alike. When this is true the dialog skips OmniRoute's own local callback server.
 */
export function shouldUseBridge(opts: {
  provider: string | undefined;
  bridgeVersion: string | null | undefined;
}): boolean {
  return !!opts.bridgeVersion && isBridgeSupportedProvider(opts.provider);
}

/**
 * OAuthModal: start OmniRoute's own local callback server for this attempt? Only for a
 * provider that has one, on true localhost, and only when the bridge is not used. With the
 * extension present the server is skipped on every host: in Docker on localhost it would
 * start inside the container on an unpublished port the host browser cannot reach.
 */
export function shouldStartLocalCallbackServer(opts: {
  provider: string | undefined;
  isTrueLocalhost: boolean;
  bridgeVersion: string | null | undefined;
  hasCallbackServer: boolean;
}): boolean {
  return (
    opts.hasCallbackServer &&
    opts.isTrueLocalhost &&
    !shouldUseBridge({ provider: opts.provider, bridgeVersion: opts.bridgeVersion })
  );
}

/**
 * The arm request for an /authorize response: its own state and redirectUri, never a
 * client-computed fallback. Null when either is missing, when redirectUri does not parse, or
 * when it is the dashboard's own origin (the redirect already lands on /callback and the
 * extension rejects it); the attempt then skips the bridge.
 */
export function bridgeArmRequestFrom(
  provider: string,
  data: Record<string, unknown> | null | undefined,
  dashboardOrigin: string
): BridgeArmRequest | null {
  const state = data?.state;
  const redirectUri = data?.redirectUri;
  if (typeof state !== "string" || !state) return null;
  if (typeof redirectUri !== "string" || !redirectUri) return null;
  try {
    if (new URL(redirectUri).origin === dashboardOrigin) return null;
  } catch {
    return null;
  }
  return { provider, state, redirectUri };
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

const IDLE_SNAPSHOT: BridgeSnapshot = { status: "idle", version: null };
const noopSubscribe = () => () => {};
const idleSnapshot = () => IDLE_SNAPSHOT;

/** The version to arm with: set only when the bridge frame is ready and this origin approved. */
export function bridgeVersionOf(snapshot: BridgeSnapshot): string | null {
  return snapshot.status === "ready" ? snapshot.version || "1" : null;
}

/**
 * Holds the page's hidden bridge frame while `active` (the Connect dialog is open) and arms it
 * for one OAuth attempt. `bridgeVersion` is non-null only once the helper is ready on this
 * (approved) dashboard; it turns non-null by itself when the operator approves it.
 * `arm` resolves true on `armed`, false on `error`, when not ready, or after
 * BRIDGE_ARM_TIMEOUT_MS.
 */
export function useOAuthBridge(active: boolean = true): {
  bridgeVersion: string | null;
  arm: (req: BridgeArmRequest) => Promise<boolean>;
} {
  const frame = typeof window === "undefined" ? null : getBridgeFrame();
  const snapshot = useSyncExternalStore(
    frame ? frame.subscribe : noopSubscribe,
    frame ? frame.snapshot : idleSnapshot,
    idleSnapshot
  );

  useEffect(() => {
    if (!active || !frame) return undefined;
    return frame.acquire();
  }, [active, frame]);

  const arm = useCallback(
    (req: BridgeArmRequest): Promise<boolean> => (frame ? frame.arm(req) : Promise.resolve(false)),
    [frame]
  );

  return { bridgeVersion: active ? bridgeVersionOf(snapshot) : null, arm };
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
