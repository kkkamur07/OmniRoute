import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HELPER_APPROVE_WINDOW_FEATURES,
  HELPER_APPROVE_WINDOW_NAME,
  BRIDGE_ARM_TIMEOUT_MS,
  BRIDGE_MOUNT_TIMEOUT_MS,
  BRIDGE_READY_TIMEOUT_MS,
  BridgeFrame,
  HELPER_DISMISS_KEY,
  OAUTH_HELPER_EXTENSION_ID,
  OAUTH_HELPER_STORE_URL,
  closeIfBlank,
  helperApproveUrl,
  helperBridgeUrl,
  helperExtensionOrigin,
  helperSetupView,
  isChromiumBrowser,
  openApproveWindow,
  originHost,
  probeHelper,
  readHelperDismissed,
  writeHelperDismissed,
} from "../../src/shared/components/oauthModal/helperExtension";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FIREFOX_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const chrome = { userAgent: CHROME_UA };

const EXT = "chrome-extension://xyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxy";

type Handler = (event: { source: unknown; origin: string; data: unknown }) => void;

/** A fake page for BridgeFrame: records frames, message listeners, posts and timers. */
function fakePage(nav: unknown = chrome) {
  const frames: Record<string, unknown>[] = [];
  const posted: { message: Record<string, unknown>; targetOrigin: string }[] = [];
  const handlers = new Set<Handler>();
  const timers: { fn: () => void; ms: number; done: boolean }[] = [];
  let seq = 0;
  const loads: (() => void)[] = [];
  const contentWindow = {
    postMessage: (message: Record<string, unknown>, targetOrigin: string) => {
      posted.push({ message, targetOrigin });
    },
  };
  const env = {
    navigator: nav as never,
    extensionId: "xyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxy",
    newRequestId: () => `r${++seq}`,
    createFrame: () => {
      const frame: Record<string, unknown> = {
        src: "",
        hidden: false,
        tabIndex: 0,
        title: "",
        style: { cssText: "" },
        attrs: {} as Record<string, string>,
        contentWindow,
        removed: false,
        setAttribute(name: string, value: string) {
          (frame.attrs as Record<string, string>)[name] = value;
        },
        addEventListener(type: string, fn: () => void) {
          if (type === "load") loads.push(fn);
        },
        remove() {
          frame.removed = true;
        },
      };
      frames.push(frame);
      return frame as never;
    },
    attach: () => {},
    addMessageListener: (fn: Handler) => handlers.add(fn),
    removeMessageListener: (fn: Handler) => handlers.delete(fn),
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t: unknown) => {
      (t as { done: boolean }).done = true;
    },
  };
  const fromFrame = (data: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    for (const fn of [...handlers]) {
      fn({
        source: contentWindow,
        origin: EXT,
        data: { source: "omniroute-oauth-bridge", ...data },
        ...over,
      });
    }
  };
  /** Fires every pending timer with exactly `ms`. */
  const fire = (ms: number) => {
    for (const t of timers.filter((x) => !x.done && x.ms === ms)) {
      t.done = true;
      t.fn();
    }
  };
  const load = () => loads.forEach((fn) => fn());
  return { env, frames, posted, handlers, timers, fromFrame, fire, load, contentWindow };
}

test("extension id, store url and resource urls", () => {
  assert.equal(OAUTH_HELPER_EXTENSION_ID, "gmckjokkoeeokoldknjmaipdbnceldil");
  assert.ok(OAUTH_HELPER_STORE_URL.endsWith(OAUTH_HELPER_EXTENSION_ID));
  assert.equal(helperBridgeUrl("abc"), "chrome-extension://abc/bridge.html");
  assert.equal(helperExtensionOrigin("abc"), "chrome-extension://abc");
  assert.equal(
    helperApproveUrl("https://dash.example.com:8443", "abc"),
    "chrome-extension://abc/approve.html?origin=https%3A%2F%2Fdash.example.com%3A8443"
  );
  assert.equal(originHost("https://dash.example.com:8443"), "dash.example.com:8443");
  assert.equal(originHost("not a url"), "not a url");
});

test("isChromiumBrowser: Chromium desktop yes, Firefox/Safari/mobile no", () => {
  assert.equal(isChromiumBrowser(chrome), true);
  assert.equal(isChromiumBrowser({ userAgent: FIREFOX_UA }), false);
  assert.equal(isChromiumBrowser({ userAgent: SAFARI_UA }), false);
  assert.equal(isChromiumBrowser({ userAgent: CHROME_UA.replace("Macintosh", "Android") }), false);
  assert.equal(
    isChromiumBrowser({ userAgentData: { brands: [{ brand: "Chromium" }], mobile: false } }),
    true
  );
  assert.equal(
    isChromiumBrowser({ userAgentData: { brands: [{ brand: "Chromium" }], mobile: true } }),
    false
  );
  assert.equal(isChromiumBrowser({ userAgentData: { brands: [{ brand: "Other" }] } }), false);
  assert.equal(isChromiumBrowser(null), false);
});

test("the dashboard default extension ID matches the manifest key and the CSP helper", async () => {
  const csp = await import("../../scripts/build/oauth-bridge-csp.mjs");
  assert.equal(OAUTH_HELPER_EXTENSION_ID, csp.DEFAULT_OAUTH_HELPER_EXTENSION_ID);
});

test("BridgeFrame mounts one hidden frame on Chromium only, reference counted", () => {
  const page = fakePage();
  const frame = new BridgeFrame(page.env);
  assert.equal(frame.snapshot().status, "idle");
  const releaseA = frame.acquire();
  const releaseB = frame.acquire();
  assert.equal(page.frames.length, 1);
  const el = page.frames[0];
  assert.equal(el.src, `${EXT}/bridge.html`);
  assert.equal(el.hidden, true);
  assert.equal(el.tabIndex, -1);
  assert.deepEqual(el.attrs, { "aria-hidden": "true" });
  assert.equal(frame.snapshot().status, "loading");
  releaseA();
  releaseA();
  assert.equal(el.removed, false);
  releaseB();
  assert.equal(el.removed, true);
  assert.equal(page.handlers.size, 0);
  assert.equal(frame.snapshot().status, "idle");

  const firefox = fakePage({ userAgent: FIREFOX_UA });
  const ff = new BridgeFrame(firefox.env);
  ff.acquire();
  assert.equal(firefox.frames.length, 0);
  assert.equal(ff.snapshot().status, "unsupported");
});

test("BridgeFrame: ready(approved) sets ready/installed; approved upgrades without a reload", () => {
  const page = fakePage();
  const frame = new BridgeFrame(page.env);
  const seen: string[] = [];
  frame.subscribe(() => seen.push(frame.snapshot().status));
  frame.acquire();
  page.fromFrame({ type: "ready", version: "0.1.0", approved: false });
  assert.deepEqual(frame.snapshot(), { status: "installed", version: "0.1.0" });
  page.fromFrame({ type: "approved", version: "0.1.0" });
  assert.deepEqual(frame.snapshot(), { status: "ready", version: "0.1.0" });
  assert.equal(page.frames.length, 1);
  // Revoked in the popup.
  page.fromFrame({ type: "ready", version: "0.1.0", approved: false });
  assert.equal(frame.snapshot().status, "installed");
  assert.deepEqual(seen, ["loading", "installed", "ready", "installed"]);
});

test("BridgeFrame ignores messages from other windows, origins and sources", () => {
  const page = fakePage();
  const frame = new BridgeFrame(page.env);
  frame.acquire();
  const ready = { type: "ready", version: "1", approved: true };
  page.fromFrame(ready, { source: {} });
  page.fromFrame(ready, { origin: "https://dash.example.com" });
  page.fromFrame(ready, { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  page.fromFrame({ ...ready, source: "omniroute-dashboard" });
  assert.equal(frame.snapshot().status, "loading");
});

test("BridgeFrame: absent when no ready within the timeout after load (or ever)", () => {
  const page = fakePage();
  const frame = new BridgeFrame(page.env);
  frame.acquire();
  page.load();
  page.fire(BRIDGE_READY_TIMEOUT_MS);
  assert.equal(frame.snapshot().status, "absent");

  const never = fakePage();
  const f2 = new BridgeFrame(never.env);
  f2.acquire();
  never.fire(BRIDGE_MOUNT_TIMEOUT_MS);
  assert.equal(f2.snapshot().status, "absent");

  // A late ready still wins (installed while the dialog was open, then reloaded).
  frame.reload();
  assert.equal(frame.snapshot().status, "loading");
  assert.equal(page.frames[0].src, `${EXT}/bridge.html`);
  page.fromFrame({ type: "ready", version: "2", approved: false });
  assert.equal(frame.snapshot().status, "installed");
  page.fire(BRIDGE_MOUNT_TIMEOUT_MS);
  assert.equal(frame.snapshot().status, "installed");
});

test("BridgeFrame.arm posts to the extension origin only when ready and matches the reply", async () => {
  const page = fakePage();
  const frame = new BridgeFrame(page.env);
  const req = { provider: "codex", state: "s", redirectUri: "http://localhost:1455/auth/callback" };
  assert.equal(await frame.arm(req), false);
  frame.acquire();
  page.fromFrame({ type: "ready", version: "1", approved: false });
  assert.equal(await frame.arm(req), false);
  assert.equal(page.posted.length, 0);
  page.fromFrame({ type: "approved" });

  const ok = frame.arm(req);
  assert.deepEqual(page.posted[0], {
    message: {
      source: "omniroute-dashboard",
      type: "oauth-bridge:arm",
      requestId: "r1",
      ...req,
    },
    targetOrigin: EXT,
  });
  page.fromFrame({ type: "oauth-bridge:armed", requestId: "other" });
  page.fromFrame(
    { type: "oauth-bridge:armed", requestId: "r1" },
    { origin: "https://evil.example" }
  );
  page.fromFrame({ type: "oauth-bridge:armed", requestId: "r1" });
  assert.equal(await ok, true);

  const bad = frame.arm(req);
  page.fromFrame({ type: "oauth-bridge:error", requestId: "r2", reason: "x" });
  assert.equal(await bad, false);

  const slow = frame.arm(req);
  page.fire(BRIDGE_ARM_TIMEOUT_MS);
  assert.equal(await slow, false);
  assert.equal(await frame.arm({ ...req, state: "" }), false);
});

test("probeHelper: ready wins, even on an unsupported browser", async () => {
  assert.equal(await probeHelper({ bridgeVersion: "1.2.0", navigator: chrome }), "ready");
  assert.equal(
    await probeHelper({ bridgeVersion: "1", navigator: { userAgent: FIREFOX_UA } }),
    "ready"
  );
});

test("probeHelper: unsupported outside Chromium, without touching the frame", async () => {
  const page = fakePage({ userAgent: FIREFOX_UA });
  const frame = new BridgeFrame(page.env);
  assert.equal(await probeHelper({ navigator: { userAgent: FIREFOX_UA }, frame }), "unsupported");
  assert.equal(await probeHelper({ navigator: { userAgent: SAFARI_UA }, frame }), "unsupported");
  assert.equal(page.frames.length, 0);
});

test("probeHelper follows the bridge frame: installed, ready, absent", async () => {
  const page = fakePage();
  const frame = new BridgeFrame(page.env);
  const hold = frame.acquire();
  const pending = probeHelper({ navigator: chrome, frame });
  page.fromFrame({ type: "ready", version: "1", approved: false });
  assert.equal(await pending, "installed");
  page.fromFrame({ type: "approved" });
  assert.equal(await probeHelper({ navigator: chrome, frame }), "ready");
  hold();

  const silent = fakePage();
  const f2 = new BridgeFrame(silent.env);
  const hold2 = f2.acquire();
  const p2 = probeHelper({ navigator: chrome, frame: f2 });
  silent.load();
  silent.fire(BRIDGE_READY_TIMEOUT_MS);
  assert.equal(await p2, "absent");
  // An absent frame is reloaded by the next probe, so a fresh install is picked up.
  const p3 = probeHelper({ navigator: chrome, frame: f2 });
  assert.equal(f2.snapshot().status, "loading");
  silent.fromFrame({ type: "ready", version: "1", approved: false });
  assert.equal(await p3, "installed");
  hold2();

  assert.equal(await probeHelper({ navigator: chrome }), "absent");
  assert.equal(await probeHelper({ navigator: chrome, frame: null }), "absent");
});

test("helperSetupView: step selection", () => {
  const base = { eligible: true, dismissed: false };
  assert.equal(helperSetupView({ ...base, probe: "absent" }), "absent");
  assert.equal(helperSetupView({ ...base, probe: "installed" }), "installed");
  assert.equal(helperSetupView({ ...base, probe: "ready" }), "none");
  assert.equal(helperSetupView({ ...base, probe: "ready", awaitingContinue: true }), "ready");
  assert.equal(helperSetupView({ ...base, probe: "unsupported" }), "none");
  assert.equal(helperSetupView({ ...base, probe: null }), "none");
  assert.equal(helperSetupView({ ...base, eligible: false, probe: "absent" }), "none");
  assert.equal(helperSetupView({ ...base, dismissed: true, probe: "installed" }), "none");
});

test("openApproveWindow opens the approve popup and survives a blocked or throwing open", () => {
  const calls: unknown[][] = [];
  const opened = openApproveWindow("https://dash.example.com", {
    open: (...args: unknown[]) => {
      calls.push(args);
      return { closed: false };
    },
  });
  assert.deepEqual(opened, { closed: false });
  assert.deepEqual(calls, [
    [
      helperApproveUrl("https://dash.example.com"),
      HELPER_APPROVE_WINDOW_NAME,
      HELPER_APPROVE_WINDOW_FEATURES,
    ],
  ]);
  assert.equal(HELPER_APPROVE_WINDOW_FEATURES, "popup,width=420,height=560");
  assert.equal(openApproveWindow("https://x", { open: () => null }), null);
  assert.equal(
    openApproveWindow("https://x", {
      open: () => {
        throw new Error("blocked");
      },
    }),
    null
  );
  assert.equal(openApproveWindow("https://x", undefined), null);
});

test("dismiss choice round-trips through storage and tolerates broken storage", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  assert.equal(readHelperDismissed(storage), false);
  writeHelperDismissed(storage);
  assert.equal(data.get(HELPER_DISMISS_KEY), "1");
  assert.equal(readHelperDismissed(storage), true);
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(readHelperDismissed(broken), false);
  assert.doesNotThrow(() => writeHelperDismissed(broken));
  assert.equal(readHelperDismissed(null), false);
});

test("closeIfBlank closes only a pre-opened window still on about:blank", () => {
  const make = (href: string | (() => string), closed = false) => {
    const win = {
      closed,
      closeCalls: 0,
      close() {
        win.closeCalls += 1;
        win.closed = true;
      },
      location: {} as { href: string },
    };
    Object.defineProperty(win.location, "href", {
      get: typeof href === "function" ? href : () => href,
    });
    return win;
  };
  const blank = make("about:blank");
  assert.equal(closeIfBlank(blank), true);
  assert.equal(blank.closeCalls, 1);
  assert.equal(closeIfBlank(blank), false, "already closed");
  assert.equal(blank.closeCalls, 1);

  const crossOrigin = make(() => {
    throw new DOMException("Blocked a frame", "SecurityError");
  });
  assert.equal(closeIfBlank(crossOrigin), false, "provider page loaded");
  assert.equal(crossOrigin.closeCalls, 0);

  const navigated = make("https://auth.openai.com/authorize");
  assert.equal(closeIfBlank(navigated), false);
  assert.equal(navigated.closeCalls, 0);

  assert.equal(closeIfBlank(make("about:blank", true)), false);
  assert.equal(closeIfBlank(null), false);
  assert.equal(closeIfBlank(undefined), false);
  const throwing = {
    location: { href: "about:blank" },
    close: () => {
      throw new Error("nope");
    },
  };
  assert.equal(closeIfBlank(throwing), false);
});
