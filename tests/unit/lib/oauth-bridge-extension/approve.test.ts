import test from "node:test";
import assert from "node:assert/strict";

const EXT_ID = "gmckjokkoeeokoldknjmaipdbnceldil";
const BASE = `chrome-extension://${EXT_ID}/`;

const mock = {
  local: new Map<string, unknown>(),
  broadcasts: [] as unknown[],
  removedTabs: [] as number[],
  broadcastFails: false,
};

// No permissions or scripting namespace: approval must not need either any more.
(globalThis as unknown as Record<string, unknown>).chrome = {
  runtime: {
    id: EXT_ID,
    getURL: (p: string) => `${BASE}${p}`,
    sendMessage: async (message: unknown) => {
      mock.broadcasts.push(message);
      if (mock.broadcastFails) throw new Error("Receiving end does not exist.");
    },
  },
  storage: {
    local: {
      get: async (key: string) => (mock.local.has(key) ? { [key]: mock.local.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) mock.local.set(k, structuredClone(v));
      },
    },
  },
  tabs: {
    remove: async (id: number) => {
      mock.removedTabs.push(id);
    },
  },
};

const { approveOriginFromSearch } =
  await import("../../../../packages/oauth-bridge-extension/src/origin.js");
const { APPROVE_CLOSE_DELAY_MS, approvePageOrigin, handleApproveOrigin } =
  await import("../../../../packages/oauth-bridge-extension/src/background.js");
const { approveOrigin, removeOrigin } =
  await import("../../../../packages/oauth-bridge-extension/src/approval.js");

const DASH = "https://dash.example.com";
const approveUrl = (origin: string) => `${BASE}approve.html?origin=${encodeURIComponent(origin)}`;
// approve.html as the top-level page of tab 11, opened for DASH.
const pageSender = {
  id: EXT_ID,
  url: approveUrl(DASH),
  origin: BASE.slice(0, -1),
  frameId: 0,
  tab: { id: 11 },
};
const approveMsg = (over: Record<string, unknown> = {}) => ({
  type: "approve-origin",
  origin: DASH,
  isFramed: false,
  ...over,
});

/** Collects setTimer calls instead of scheduling them. */
function timers() {
  const calls: { fn: () => void; ms: number }[] = [];
  return {
    calls,
    setTimer: (fn: () => void, ms: number) => {
      calls.push({ fn, ms });
      return 0;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

function reset() {
  mock.local.clear();
  mock.broadcasts = [];
  mock.removedTabs = [];
  mock.broadcastFails = false;
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

test("approvePageOrigin accepts only approve.html as a top-level tab, and returns its origin", () => {
  assert.equal(approvePageOrigin(pageSender), DASH);
  const rejected: unknown[] = [
    undefined,
    {},
    // Framed (frameId > 0) or not in a tab.
    { ...pageSender, frameId: 2 },
    { ...pageSender, frameId: undefined },
    { ...pageSender, tab: undefined },
    // Another page of this extension, a web page, another extension.
    { ...pageSender, url: `${BASE}bridge.html?origin=${encodeURIComponent(DASH)}` },
    { ...pageSender, url: `${DASH}/approve.html?origin=${encodeURIComponent(DASH)}` },
    { ...pageSender, url: `${DASH}/?${BASE}approve.html` },
    { ...pageSender, id: "other-extension" },
    { ...pageSender, url: approveUrl("https://dash.example.com/x") },
    { ...pageSender, url: `${BASE}approve.html` },
  ];
  for (const s of rejected) assert.equal(approvePageOrigin(s), null, JSON.stringify(s));
});

test("approve-origin from anything but a top-level approve page stores nothing", async () => {
  reset();
  const t = timers();
  for (const sender of [
    { id: EXT_ID, url: `${DASH}/dashboard`, origin: DASH, frameId: 0, tab: { id: 3 } },
    { ...pageSender, frameId: 1 },
    { ...pageSender, url: `${BASE}bridge.html` },
    { ...pageSender, id: "evil" },
    {},
  ]) {
    const r = await handleApproveOrigin(approveMsg(), sender, t);
    assert.deepEqual(r, { ok: false, reason: "unapproved-origin" });
  }
  assert.equal(mock.local.has("approvedOrigins"), false);
  assert.deepEqual(mock.broadcasts, []);
  assert.equal(t.calls.length, 0);
});

test("approve-origin rejects framed pages, other origins and invalid messages", async () => {
  reset();
  const t = timers();
  for (const origin of [`${DASH}/x`, "javascript:1", 42, undefined]) {
    const r = await handleApproveOrigin(approveMsg({ origin }), pageSender, t);
    assert.deepEqual(r, { ok: false, reason: "invalid-message" });
  }
  assert.deepEqual(await handleApproveOrigin(approveMsg({ type: "x" }), pageSender, t), {
    ok: false,
    reason: "invalid-message",
  });
  const unapproved = { ok: false, reason: "unapproved-origin" };
  // The page says it is framed, or does not say it is not.
  assert.deepEqual(
    await handleApproveOrigin(approveMsg({ isFramed: true }), pageSender, t),
    unapproved
  );
  assert.deepEqual(
    await handleApproveOrigin(approveMsg({ isFramed: undefined }), pageSender, t),
    unapproved
  );
  // An origin other than the one the page was opened for (and shows).
  assert.deepEqual(
    await handleApproveOrigin(approveMsg({ origin: "https://evil.example" }), pageSender, t),
    unapproved
  );
  assert.equal(mock.local.has("approvedOrigins"), false);
  assert.equal(t.calls.length, 0);
});

test("approve-origin stores the origin, tells bridge frames and closes the tab after ~1 s", async () => {
  reset();
  mock.local.set("approvedOrigins", ["https://old.example.com"]);
  const t = timers();
  const r = await handleApproveOrigin(approveMsg(), pageSender, t);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(mock.local.get("approvedOrigins"), ["https://old.example.com", DASH]);
  assert.deepEqual(mock.broadcasts, [{ type: "origin-approved", origin: DASH }]);

  // The tab stays open (showing "Allowed") until the timer fires, then the worker closes it.
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].ms, APPROVE_CLOSE_DELAY_MS);
  assert.ok(APPROVE_CLOSE_DELAY_MS >= 500 && APPROVE_CLOSE_DELAY_MS <= 2000);
  assert.deepEqual(mock.removedTabs, []);
  t.calls[0].fn();
  await flush();
  assert.deepEqual(mock.removedTabs, [11]);

  // Approving again is idempotent.
  await handleApproveOrigin(approveMsg(), pageSender, timers());
  assert.deepEqual(mock.local.get("approvedOrigins"), ["https://old.example.com", DASH]);
});

test("approve-origin still succeeds and closes the tab when no bridge frame is listening", async () => {
  reset();
  mock.broadcastFails = true;
  const t = timers();
  assert.deepEqual(await handleApproveOrigin(approveMsg(), pageSender, t), { ok: true });
  assert.deepEqual(mock.local.get("approvedOrigins"), [DASH]);
  t.calls[0].fn();
  await flush();
  assert.deepEqual(mock.removedTabs, [11]);
});

test("approveOrigin / removeOrigin only edit the stored list", async () => {
  reset();
  const c = (globalThis as unknown as { chrome: unknown }).chrome;
  assert.deepEqual(await approveOrigin(c, DASH), [DASH]);
  assert.deepEqual(await approveOrigin(c, DASH), [DASH]);
  await assert.rejects(() => approveOrigin(c, "nope"));
  assert.deepEqual(await removeOrigin(c, DASH), []);
  assert.deepEqual(mock.local.get("approvedOrigins"), []);
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
