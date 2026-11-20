/**
 * Detecting and onboarding the OmniRoute Sign-in Helper browser extension.
 *
 * Three signals, strongest first:
 * - "ready": the content script runs on this page (dataset marker or `ready` message, see
 *   useOAuthBridge.ts), so the dialog can arm it.
 * - "installed": `chrome-extension://<id>/ping.json` (a web-accessible resource) answers, but
 *   this dashboard origin is not approved yet. `openApproveWindow` lets the user approve it.
 * - "absent": nothing answers. "unsupported": not a desktop Chromium browser.
 *
 * Pure helpers take their environment as arguments so Node tests can stub it.
 */

export const HELPER_PING_NAME = "omniroute-oauth-bridge";

/**
 * Extension ID derived from the manifest `key` committed in packages/oauth-bridge-extension, so an
 * unpacked developer build and the packed build share it. The Chrome Web Store ID replaces this
 * value once the extension is published. Override with NEXT_PUBLIC_OAUTH_HELPER_EXTENSION_ID.
 */
const DEFAULT_EXTENSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const EXTENSION_ID_RE = /^[a-p]{32}$/;

export const OAUTH_HELPER_EXTENSION_ID: string = (() => {
  const override = (process.env.NEXT_PUBLIC_OAUTH_HELPER_EXTENSION_ID || "").trim();
  return EXTENSION_ID_RE.test(override) ? override : DEFAULT_EXTENSION_ID;
})();

export const OAUTH_HELPER_STORE_URL: string =
  (process.env.NEXT_PUBLIC_OAUTH_HELPER_STORE_URL || "").trim() ||
  `https://chromewebstore.google.com/detail/${OAUTH_HELPER_EXTENSION_ID}`;

export const HELPER_APPROVE_WINDOW_NAME = "omniroute-helper-approve";
export const HELPER_APPROVE_WINDOW_FEATURES = "popup,width=420,height=560";
export const HELPER_POLL_INTERVAL_MS = 2000;
export const HELPER_PING_TIMEOUT_MS = 1500;
/** localStorage key for "always paste the link, do not offer the helper again". */
export const HELPER_DISMISS_KEY = "omniroute.oauthHelper.dismissed";

export type HelperProbe = "ready" | "installed" | "absent" | "unsupported";

type NavigatorLike = {
  userAgent?: string;
  userAgentData?: { brands?: { brand?: string }[]; mobile?: boolean } | null;
};

export type ProbeEnv = {
  navigator?: NavigatorLike | null;
  /** The bridge version the page already detected (dataset marker / `ready` message). */
  bridgeVersion?: string | null;
  fetch?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  extensionId?: string;
  timeoutMs?: number;
};

/** True for a desktop Chromium browser (Chrome, Edge, Brave, Opera, Arc...). */
export function isChromiumBrowser(nav: NavigatorLike | null | undefined): boolean {
  if (!nav) return false;
  const data = nav.userAgentData;
  if (data && Array.isArray(data.brands)) {
    if (data.mobile) return false;
    return data.brands.some((b) => typeof b?.brand === "string" && /Chromium/i.test(b.brand));
  }
  const ua = nav.userAgent || "";
  if (/Android|iPhone|iPad|Mobile|CriOS|FxiOS|EdgiOS/.test(ua)) return false;
  return /(Chrome|Chromium)\/\d/.test(ua) && !/Firefox\//.test(ua);
}

export function helperPingUrl(extensionId: string = OAUTH_HELPER_EXTENSION_ID): string {
  return `chrome-extension://${extensionId}/ping.json`;
}

export function helperApproveUrl(
  origin: string,
  extensionId: string = OAUTH_HELPER_EXTENSION_ID
): string {
  return `chrome-extension://${extensionId}/approve.html?origin=${encodeURIComponent(origin)}`;
}

function defaultEnv(): ProbeEnv {
  if (typeof window === "undefined") return {};
  return {
    navigator: window.navigator as NavigatorLike,
    bridgeVersion: document.documentElement?.dataset?.omnirouteOauthBridge || null,
    fetch: window.fetch.bind(window),
  };
}

/** Where the helper stands for this page. Never throws. */
export async function probeHelper(env: ProbeEnv = defaultEnv()): Promise<HelperProbe> {
  if (env.bridgeVersion) return "ready";
  if (!isChromiumBrowser(env.navigator)) return "unsupported";
  if (typeof env.fetch !== "function") return "absent";
  const timeoutMs = env.timeoutMs ?? HELPER_PING_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const request = env
      .fetch(helperPingUrl(env.extensionId), { cache: "no-store" })
      .then(async (res) => (res.ok ? await res.json() : null));
    const body = (await Promise.race([request, timeout])) as Record<string, unknown> | null;
    return body && typeof body === "object" && body.name === HELPER_PING_NAME
      ? "installed"
      : "absent";
  } catch {
    return "absent";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Opens the extension's approve page for `origin`; null when the popup was blocked. */
export function openApproveWindow(
  origin: string,
  opener:
    | { open: (url: string, name: string, features: string) => unknown }
    | undefined = typeof window === "undefined" ? undefined : window
): unknown {
  if (!opener) return null;
  try {
    return opener.open(
      helperApproveUrl(origin),
      HELPER_APPROVE_WINDOW_NAME,
      HELPER_APPROVE_WINDOW_FEATURES
    );
  } catch {
    return null;
  }
}

export type HelperSetupView = "none" | "absent" | "installed" | "ready";

/**
 * Which helper-setup view a dialog shows. `eligible` means the flow would use the bridge if the
 * helper were ready (supported provider on a remote dashboard). `awaitingContinue` keeps the view
 * up once the helper became ready but the flow could not continue on its own.
 */
export function helperSetupView(opts: {
  eligible: boolean;
  probe: HelperProbe | null;
  dismissed: boolean;
  awaitingContinue?: boolean;
}): HelperSetupView {
  if (!opts.eligible || opts.dismissed || !opts.probe) return "none";
  if (opts.probe === "ready") return opts.awaitingContinue ? "ready" : "none";
  if (opts.probe === "unsupported") return "none";
  return opts.probe;
}

export function readHelperDismissed(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    return store?.getItem(HELPER_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeHelperDismissed(storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    store?.setItem(HELPER_DISMISS_KEY, "1");
  } catch {
    // Storage unavailable: the choice lasts for this dialog only.
  }
}

/** Host shown on the "Allow on <host>" button. */
export function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
