import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HELPER_APPROVE_WINDOW_FEATURES,
  HELPER_APPROVE_WINDOW_NAME,
  HELPER_DISMISS_KEY,
  HELPER_PING_NAME,
  OAUTH_HELPER_EXTENSION_ID,
  OAUTH_HELPER_STORE_URL,
  closeIfBlank,
  helperApproveUrl,
  helperPingUrl,
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

function pingFetch(body: unknown, ok = true) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return { ok, json: async () => body };
  };
  return { fn, calls };
}

test("extension id, store url and resource urls", () => {
  assert.equal(OAUTH_HELPER_EXTENSION_ID, "gmckjokkoeeokoldknjmaipdbnceldil");
  assert.ok(OAUTH_HELPER_STORE_URL.endsWith(OAUTH_HELPER_EXTENSION_ID));
  assert.equal(helperPingUrl("abc"), "chrome-extension://abc/ping.json");
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

test("probeHelper: ready wins, even on an unsupported browser", async () => {
  const { fn, calls } = pingFetch({ name: HELPER_PING_NAME });
  assert.equal(
    await probeHelper({ bridgeVersion: "1.2.0", navigator: chrome, fetch: fn }),
    "ready"
  );
  assert.equal(
    await probeHelper({ bridgeVersion: "1", navigator: { userAgent: FIREFOX_UA } }),
    "ready"
  );
  assert.equal(calls.length, 0);
});

test("probeHelper: unsupported outside Chromium, without fetching", async () => {
  const { fn, calls } = pingFetch({ name: HELPER_PING_NAME });
  assert.equal(
    await probeHelper({ navigator: { userAgent: FIREFOX_UA }, fetch: fn }),
    "unsupported"
  );
  assert.equal(
    await probeHelper({ navigator: { userAgent: SAFARI_UA }, fetch: fn }),
    "unsupported"
  );
  assert.equal(calls.length, 0);
});

test("probeHelper: installed when ping.json answers with the helper name", async () => {
  const { fn, calls } = pingFetch({ name: HELPER_PING_NAME, version: 2 });
  assert.equal(
    await probeHelper({ navigator: chrome, fetch: fn, extensionId: "xyz" }),
    "installed"
  );
  assert.deepEqual(calls, ["chrome-extension://xyz/ping.json"]);
});

test("probeHelper: absent on network error, bad body, non-ok or timeout", async () => {
  const failing = async () => {
    throw new TypeError("Failed to fetch");
  };
  assert.equal(await probeHelper({ navigator: chrome, fetch: failing }), "absent");
  assert.equal(
    await probeHelper({ navigator: chrome, fetch: pingFetch({ name: "other" }).fn }),
    "absent"
  );
  assert.equal(await probeHelper({ navigator: chrome, fetch: pingFetch(null).fn }), "absent");
  assert.equal(
    await probeHelper({
      navigator: chrome,
      fetch: pingFetch({ name: HELPER_PING_NAME }, false).fn,
    }),
    "absent"
  );
  const hanging = () => new Promise<never>(() => {});
  assert.equal(await probeHelper({ navigator: chrome, fetch: hanging, timeoutMs: 10 }), "absent");
  assert.equal(await probeHelper({ navigator: chrome }), "absent");
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
