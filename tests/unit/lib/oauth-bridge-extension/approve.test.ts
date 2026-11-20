import test from "node:test";
import assert from "node:assert/strict";

const EXT_ID = "gmckjokkoeeokoldknjmaipdbnceldil";
const BASE = `chrome-extension://${EXT_ID}/`;

interface Script {
  id: string;
  matches: string[];
}
const mock = {
  local: new Map<string, unknown>(),
  granted: new Set<string>(),
  scripts: [] as Script[],
  tabs: [] as { id: number; url: string }[],
  injected: [] as number[],
  queries: [] as string[],
};

(globalThis as unknown as Record<string, unknown>).chrome = {
  runtime: { id: EXT_ID, getURL: (p: string) => `${BASE}${p}` },
  storage: {
    local: {
      get: async (key: string) => (mock.local.has(key) ? { [key]: mock.local.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) mock.local.set(k, structuredClone(v));
      },
    },
  },
  permissions: {
    contains: async (q: { origins: string[] }) => q.origins.every((o) => mock.granted.has(o)),
  },
  tabs: {
    query: async (q: { url: string }) => {
      mock.queries.push(q.url);
      return structuredClone(mock.tabs);
    },
  },
  scripting: {
    getRegisteredContentScripts: async () => structuredClone(mock.scripts),
    unregisterContentScripts: async () => {
      mock.scripts = [];
    },
    registerContentScripts: async (s: Script[]) => {
      mock.scripts = structuredClone(s);
    },
    executeScript: async (o: { target: { tabId: number } }) => {
      mock.injected.push(o.target.tabId);
    },
  },
};

const { approveOriginFromSearch } =
  await import("../../../../packages/oauth-bridge-extension/src/origin.js");
const { handleApproveOrigin, isExtensionPageSender } =
  await import("../../../../packages/oauth-bridge-extension/src/background.js");

const DASH = "https://dash.example.com";
const pageSender = { id: EXT_ID, url: `${BASE}approve.html?origin=x`, origin: BASE.slice(0, -1) };

function reset() {
  mock.local.clear();
  mock.granted.clear();
  mock.scripts = [];
  mock.tabs = [];
  mock.injected = [];
  mock.queries = [];
}

test("approveOriginFromSearch accepts bare http(s) origins", () => {
  const q = (o: string) => `?origin=${encodeURIComponent(o)}`;
  assert.equal(approveOriginFromSearch(q(DASH)), DASH);
  assert.equal(
    approveOriginFromSearch(q("https://dash.example.com:8443")),
    "https://dash.example.com:8443"
  );
  assert.equal(
    approveOriginFromSearch(q("http://192.168.0.15:20128")),
    "http://192.168.0.15:20128"
  );
});

test("approveOriginFromSearch rejects paths, queries, other schemes and junk", () => {
  const q = (o: string) => `?origin=${encodeURIComponent(o)}`;
  for (const bad of [
    `${DASH}/`,
    `${DASH}/dashboard`,
    `${DASH}?a=1`,
    `${DASH}#x`,
    "https://user:pw@dash.example.com",
    "javascript:alert(1)",
    "chrome-extension://abc",
    "file:///etc/passwd",
    "ftp://dash.example.com",
    "data:text/html,hi",
    "HTTPS://DASH.example.com",
    "dash.example.com",
    "",
    `https://${"a".repeat(300)}.com`,
  ]) {
    assert.equal(approveOriginFromSearch(q(bad)), null, bad);
  }
  assert.equal(approveOriginFromSearch(""), null);
  assert.equal(approveOriginFromSearch("?other=1"), null);
  assert.equal(approveOriginFromSearch(undefined as unknown as string), null);
});

test("isExtensionPageSender only accepts this extension's own pages", () => {
  assert.equal(isExtensionPageSender(pageSender), true);
  // Content script on a dashboard: same extension id, but the web page's url and origin.
  assert.equal(
    isExtensionPageSender({ id: EXT_ID, url: `${DASH}/dashboard`, origin: DASH, tab: { id: 1 } }),
    false
  );
  // Web page spoofing the extension URL in a path or query.
  assert.equal(isExtensionPageSender({ id: EXT_ID, url: `${DASH}/?${BASE}`, origin: DASH }), false);
  assert.equal(isExtensionPageSender({ id: "other-extension", url: `${BASE}approve.html` }), false);
  assert.equal(
    isExtensionPageSender({ id: EXT_ID, url: `${BASE}approve.html`, origin: DASH }),
    false
  );
  assert.equal(isExtensionPageSender({ id: EXT_ID }), false);
  assert.equal(isExtensionPageSender(undefined), false);
});

test("approve-origin from a content script or web page is rejected and stores nothing", async () => {
  reset();
  mock.granted.add(`${DASH}/*`);
  const msg = { type: "approve-origin", origin: DASH };
  for (const sender of [
    { id: EXT_ID, url: `${DASH}/dashboard`, origin: DASH, tab: { id: 3 } },
    { id: "evil", url: `${BASE}approve.html` },
    {},
  ]) {
    const r = await handleApproveOrigin(msg, sender);
    assert.deepEqual(r, { ok: false, reason: "unapproved-origin" });
  }
  assert.equal(mock.local.has("approvedOrigins"), false);
  assert.equal(mock.scripts.length, 0);
});

test("approve-origin rejects invalid origins and ungranted permissions", async () => {
  reset();
  for (const origin of [`${DASH}/x`, "javascript:1", 42, undefined]) {
    const r = await handleApproveOrigin({ type: "approve-origin", origin }, pageSender);
    assert.deepEqual(r, { ok: false, reason: "invalid-message" });
  }
  const r = await handleApproveOrigin({ type: "approve-origin", origin: DASH }, pageSender);
  assert.deepEqual(r, { ok: false, reason: "unapproved-origin" });
  assert.equal(mock.local.has("approvedOrigins"), false);
});

test("approve-origin stores the origin, registers and injects into open tabs", async () => {
  reset();
  mock.local.set("approvedOrigins", ["https://old.example.com"]);
  mock.granted.add(`${DASH}/*`);
  mock.tabs = [
    { id: 7, url: `${DASH}/dashboard/providers` },
    { id: 8, url: "https://elsewhere.example.com/" },
  ];
  const r = await handleApproveOrigin({ type: "approve-origin", origin: DASH }, pageSender);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(mock.local.get("approvedOrigins"), ["https://old.example.com", DASH]);
  assert.deepEqual(mock.scripts[0].matches, ["https://old.example.com/*", `${DASH}/*`]);
  assert.deepEqual(mock.queries, [`${DASH}/*`]);
  assert.deepEqual(mock.injected, [7]);

  // Approving again is idempotent.
  await handleApproveOrigin({ type: "approve-origin", origin: DASH }, pageSender);
  assert.deepEqual(mock.local.get("approvedOrigins"), ["https://old.example.com", DASH]);
});

test("isFramed: top-level is not framed, iframes and throwing accessors are", async () => {
  const { isFramed } = await import("../../../../packages/oauth-bridge-extension/src/approve.js");
  const top = {} as { top?: unknown; self?: unknown };
  top.top = top;
  top.self = top;
  assert.equal(isFramed(top), false);
  assert.equal(isFramed({ top: {}, self: {} }), true);
  const crossOrigin = {
    self: {},
    get top() {
      throw new Error("SecurityError");
    },
  };
  assert.equal(isFramed(crossOrigin), true);
  assert.equal(isFramed(null), true);
});

test("enableAfterDelay keeps the Allow button disabled for ENABLE_DELAY_MS", async () => {
  const { enableAfterDelay, ENABLE_DELAY_MS } =
    await import("../../../../packages/oauth-bridge-extension/src/approve.js");
  assert.ok(ENABLE_DELAY_MS >= 500);
  const button = { disabled: false };
  let pending: (() => void) | null = null;
  let delay = -1;
  enableAfterDelay(button, ENABLE_DELAY_MS, (fn: () => void, ms: number) => {
    pending = fn;
    delay = ms;
    return 0;
  });
  assert.equal(button.disabled, true);
  assert.equal(delay, ENABLE_DELAY_MS);
  pending!();
  assert.equal(button.disabled, false);
});
