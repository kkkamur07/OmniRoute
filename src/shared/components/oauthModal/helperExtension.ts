/**
 * Detecting, onboarding and talking to the OmniRoute Sign-in Helper browser extension.
 *
 * While a Connect dialog is open (and only on desktop Chromium) the dashboard mounts one hidden
 * iframe, `chrome-extension://<id>/bridge.html` (BridgeFrame below). The frame announces
 * `{source: "omniroute-oauth-bridge", type: "ready", version, approved}` when it loads, and
 * `{type: "approved"}` once the operator allows this dashboard on the approve page. Every
 * message is accepted only from that iframe's window and from the extension origin.
 *
 * Probe results, strongest first:
 * - "ready": the frame answered and this origin is approved, so the dialog can arm it.
 * - "installed": the frame answered but this origin is not approved yet. `openApproveWindow`
 *   lets the user approve it; the frame then reports `approved` without a reload.
 * - "absent": the frame did not answer within BRIDGE_READY_TIMEOUT_MS of loading.
 * - "unsupported": not a desktop Chromium browser.
 *
 * Pure helpers take their environment as arguments so Node tests can stub it.
 */

export const BRIDGE_SOURCE = "omniroute-oauth-bridge";
export const DASHBOARD_SOURCE = "omniroute-dashboard";

/**
 * Extension ID derived from the manifest `key` committed in packages/oauth-bridge-extension, so an
 * unpacked developer build and the packed build share it. The Chrome Web Store ID replaces this
 * value once the extension is published. Override with NEXT_PUBLIC_OAUTH_HELPER_EXTENSION_ID.
 */
const DEFAULT_EXTENSION_ID = "gmckjokkoeeokoldknjmaipdbnceldil";

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
/** How long after the bridge frame loads its `ready` may take before the helper is "absent". */
export const BRIDGE_READY_TIMEOUT_MS = 1500;
/** Upper bound when the frame never fires `load` (blocked navigation). */
export const BRIDGE_MOUNT_TIMEOUT_MS = 4000;
export const BRIDGE_ARM_TIMEOUT_MS = 1500;
/** localStorage key for "always paste the link, do not offer the helper again". */
export const HELPER_DISMISS_KEY = "omniroute.oauthHelper.dismissed";

export type HelperProbe = "ready" | "installed" | "absent" | "unsupported";

type NavigatorLike = {
  userAgent?: string;
  userAgentData?: { brands?: { brand?: string }[]; mobile?: boolean } | null;
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

export function helperExtensionOrigin(extensionId: string = OAUTH_HELPER_EXTENSION_ID): string {
  return `chrome-extension://${extensionId}`;
}

export function helperBridgeUrl(extensionId: string = OAUTH_HELPER_EXTENSION_ID): string {
  return `${helperExtensionOrigin(extensionId)}/bridge.html`;
}

export function helperApproveUrl(
  origin: string,
  extensionId: string = OAUTH_HELPER_EXTENSION_ID
): string {
  return `chrome-extension://${extensionId}/approve.html?origin=${encodeURIComponent(origin)}`;
}

/** The subset of MessageEvent the guards read (keeps them testable without a DOM). */
export type BridgeMessageEvent = { source: unknown; origin: string; data: unknown };

/**
 * The message data when `event` comes from the bridge iframe's window (`frameWindow`) and the
 * extension origin, with source "omniroute-oauth-bridge"; else null.
 */
export function bridgeFrameData(
  event: BridgeMessageEvent | null | undefined,
  frameWindow: unknown,
  extensionOrigin: string
): Record<string, unknown> | null {
  if (!event || !frameWindow || event.source !== frameWindow) return null;
  if (event.origin !== extensionOrigin) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  return record.source === BRIDGE_SOURCE ? record : null;
}

export type BridgeStatus = "idle" | "unsupported" | "loading" | "absent" | "installed" | "ready";
export type BridgeSnapshot = { status: BridgeStatus; version: string | null };
export type BridgeArmRequest = { provider: string; state: string; redirectUri: string };

type FrameElement = {
  src: string;
  hidden: boolean;
  tabIndex: number;
  title: string;
  style: { cssText: string };
  contentWindow: { postMessage: (message: unknown, targetOrigin: string) => void } | null;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (type: string, fn: () => void) => void;
  remove: () => void;
};

/** What BridgeFrame needs from the page; `browserBridgeEnv` builds it from window/document. */
export type BridgeFrameEnv = {
  navigator: NavigatorLike | null | undefined;
  createFrame: () => FrameElement;
  attach: (frame: FrameElement) => void;
  addMessageListener: (fn: (event: BridgeMessageEvent) => void) => void;
  removeMessageListener: (fn: (event: BridgeMessageEvent) => void) => void;
  extensionId?: string;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  newRequestId?: () => string;
};

function fallbackRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * The one hidden bridge iframe of this page. `acquire` mounts it (reference counted; desktop
 * Chromium only) and returns the matching release; the last release removes it. `subscribe` /
 * `snapshot` follow its status for useSyncExternalStore.
 */
export class BridgeFrame {
  private readonly env: BridgeFrameEnv;
  private readonly extensionOrigin: string;
  private readonly url: string;
  private refs = 0;
  private frame: FrameElement | null = null;
  private state: BridgeSnapshot = { status: "idle", version: null };
  private readonly listeners = new Set<() => void>();
  private readonly replies = new Map<string, (data: Record<string, unknown>) => void>();
  private readyTimer: unknown = undefined;
  private readonly onMessage = (event: BridgeMessageEvent) => this.handleMessage(event);

  constructor(env: BridgeFrameEnv) {
    this.env = env;
    const id = env.extensionId ?? OAUTH_HELPER_EXTENSION_ID;
    this.extensionOrigin = helperExtensionOrigin(id);
    this.url = helperBridgeUrl(id);
  }

  snapshot = (): BridgeSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  acquire(): () => void {
    this.refs += 1;
    if (this.refs === 1) this.mount();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs -= 1;
      if (this.refs === 0) this.unmount();
    };
  }

  /** Loads the frame again (after the helper was installed while the dialog was open). */
  reload(): void {
    if (!this.frame) return;
    this.set({ status: "loading", version: null });
    this.armReadyTimer(BRIDGE_MOUNT_TIMEOUT_MS);
    this.frame.src = this.url;
  }

  /** Resolves with the snapshot once the status is no longer "loading" (or after `timeoutMs`). */
  whenSettled(timeoutMs: number = BRIDGE_MOUNT_TIMEOUT_MS): Promise<BridgeSnapshot> {
    if (this.state.status !== "loading") return Promise.resolve(this.state);
    return new Promise((resolve) => {
      let timer: unknown = undefined;
      const unsubscribe = this.subscribe(() => {
        if (this.state.status === "loading") return;
        unsubscribe();
        this.clear(timer);
        resolve(this.state);
      });
      timer = this.schedule(() => {
        unsubscribe();
        resolve(this.state);
      }, timeoutMs);
    });
  }

  /** Arms the helper for one attempt; true on `armed`, false on error, timeout or not ready. */
  arm(req: BridgeArmRequest): Promise<boolean> {
    const { provider, state, redirectUri } = req || ({} as BridgeArmRequest);
    const target = this.frame?.contentWindow;
    if (!provider || !state || !redirectUri) return Promise.resolve(false);
    if (this.state.status !== "ready" || !target) return Promise.resolve(false);
    const requestId = (this.env.newRequestId ?? fallbackRequestId)();
    return new Promise<boolean>((resolve) => {
      let timer: unknown = undefined;
      const finish = (ok: boolean) => {
        if (!this.replies.has(requestId)) return;
        this.replies.delete(requestId);
        this.clear(timer);
        resolve(ok);
      };
      this.replies.set(requestId, (data) => finish(data.type === "oauth-bridge:armed"));
      timer = this.schedule(() => finish(false), BRIDGE_ARM_TIMEOUT_MS);
      try {
        target.postMessage(
          {
            source: DASHBOARD_SOURCE,
            type: "oauth-bridge:arm",
            requestId,
            provider,
            state,
            redirectUri,
          },
          this.extensionOrigin
        );
      } catch {
        finish(false);
      }
    });
  }

  private mount(): void {
    if (!isChromiumBrowser(this.env.navigator)) {
      this.set({ status: "unsupported", version: null });
      return;
    }
    let frame: FrameElement;
    try {
      frame = this.env.createFrame();
      frame.hidden = true;
      frame.tabIndex = -1;
      frame.title = "OmniRoute Sign-in Helper";
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = "display:none";
      frame.addEventListener("load", () => {
        if (this.frame === frame && this.state.status === "loading") {
          this.armReadyTimer(BRIDGE_READY_TIMEOUT_MS);
        }
      });
      this.env.addMessageListener(this.onMessage);
      frame.src = this.url;
      this.env.attach(frame);
    } catch {
      this.env.removeMessageListener(this.onMessage);
      this.set({ status: "absent", version: null });
      return;
    }
    this.frame = frame;
    this.set({ status: "loading", version: null });
    this.armReadyTimer(BRIDGE_MOUNT_TIMEOUT_MS);
  }

  private unmount(): void {
    this.clear(this.readyTimer);
    this.readyTimer = undefined;
    this.env.removeMessageListener(this.onMessage);
    try {
      this.frame?.remove();
    } catch {
      // Already detached.
    }
    this.frame = null;
    for (const reply of [...this.replies.values()]) reply({ type: "oauth-bridge:error" });
    this.set({ status: "idle", version: null });
  }

  private handleMessage(event: BridgeMessageEvent): void {
    const data = bridgeFrameData(event, this.frame?.contentWindow, this.extensionOrigin);
    if (!data) return;
    const version =
      data.version !== undefined && data.version !== null ? String(data.version) : null;
    if (data.type === "ready") {
      this.clear(this.readyTimer);
      this.readyTimer = undefined;
      this.set({
        status: data.approved === true ? "ready" : "installed",
        version: version || this.state.version || "1",
      });
      return;
    }
    if (data.type === "approved") {
      this.clear(this.readyTimer);
      this.readyTimer = undefined;
      this.set({ status: "ready", version: version || this.state.version || "1" });
      return;
    }
    if (data.type === "oauth-bridge:armed" || data.type === "oauth-bridge:error") {
      const requestId = typeof data.requestId === "string" ? data.requestId : "";
      this.replies.get(requestId)?.(data);
    }
  }

  private armReadyTimer(ms: number): void {
    this.clear(this.readyTimer);
    this.readyTimer = this.schedule(() => {
      this.readyTimer = undefined;
      if (this.state.status === "loading") this.set({ status: "absent", version: null });
    }, ms);
  }

  private set(next: BridgeSnapshot): void {
    if (next.status === this.state.status && next.version === this.state.version) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  private schedule(fn: () => void, ms: number): unknown {
    return (this.env.setTimeout ?? ((f, t) => setTimeout(f, t)))(fn, ms);
  }

  private clear(handle: unknown): void {
    if (handle === undefined) return;
    (this.env.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }
}

/** BridgeFrameEnv for the real page. */
export function browserBridgeEnv(): BridgeFrameEnv {
  return {
    navigator: window.navigator as NavigatorLike,
    createFrame: () => document.createElement("iframe") as unknown as FrameElement,
    attach: (frame) => {
      document.body.appendChild(frame as unknown as Node);
    },
    addMessageListener: (fn) => window.addEventListener("message", fn as (e: MessageEvent) => void),
    removeMessageListener: (fn) =>
      window.removeEventListener("message", fn as (e: MessageEvent) => void),
  };
}

let pageBridge: BridgeFrame | null = null;

/** This page's BridgeFrame (created on first use); null during server rendering. */
export function getBridgeFrame(): BridgeFrame | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  pageBridge ??= new BridgeFrame(browserBridgeEnv());
  return pageBridge;
}

export type ProbeEnv = {
  navigator?: NavigatorLike | null;
  /** The bridge version the page already has (an approved, ready frame). */
  bridgeVersion?: string | null;
  frame?: Pick<BridgeFrame, "acquire" | "snapshot" | "reload" | "whenSettled"> | null;
  timeoutMs?: number;
};

function defaultEnv(): ProbeEnv {
  if (typeof window === "undefined") return {};
  return { navigator: window.navigator as NavigatorLike, frame: getBridgeFrame() };
}

/** Maps a bridge status to the probe result the setup step uses. */
export function probeFromStatus(status: BridgeStatus): HelperProbe {
  if (status === "ready" || status === "installed" || status === "unsupported") return status;
  return "absent";
}

/**
 * Where the helper stands for this page. Holds the bridge frame for the duration of the probe,
 * reloads it when it was "absent" (the helper may have been installed since), then waits for it
 * to settle. Never throws.
 */
export async function probeHelper(env: ProbeEnv = defaultEnv()): Promise<HelperProbe> {
  if (env.bridgeVersion) return "ready";
  if (!isChromiumBrowser(env.navigator)) return "unsupported";
  const frame = env.frame;
  if (!frame) return "absent";
  let release: (() => void) | null = null;
  try {
    release = frame.acquire();
    if (frame.snapshot().status === "absent") frame.reload();
    const settled = await frame.whenSettled(env.timeoutMs);
    return probeFromStatus(settled.status);
  } catch {
    return "absent";
  } finally {
    release?.();
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

/** The subset of a window `closeIfBlank` touches. */
export type PreopenedWindow = { closed?: boolean; close: () => void; location: { href: string } };

/**
 * Closes a window pre-opened on about:blank when the sign-in failed before the provider page was
 * loaded into it. A window that navigated away (cross-origin reads throw) is left alone.
 * @returns true when the window was closed.
 */
export function closeIfBlank(win: PreopenedWindow | null | undefined): boolean {
  if (!win || win.closed) return false;
  let blank = false;
  try {
    blank = win.location.href === "about:blank";
  } catch {
    blank = false;
  }
  if (!blank) return false;
  try {
    win.close();
    return true;
  } catch {
    return false;
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
