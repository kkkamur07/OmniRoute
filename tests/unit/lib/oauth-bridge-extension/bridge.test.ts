import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptedParentOrigin,
  armForward,
  embeddingOrigin,
  startBridge,
} from "../../../../packages/oauth-bridge-extension/src/bridge.js";

const EXT_ID = "gmckjokkoeeokoldknjmaipdbnceldil";
const DASH = "https://dash.example.com";

type Listener = (...args: unknown[]) => unknown;

/** A fake parent window that records what the frame posts to it. */
function fakeParent() {
  const posted: { message: Record<string, unknown>; targetOrigin: string }[] = [];
  const parent: Record<string, unknown> = {
    postMessage: (message: Record<string, unknown>, targetOrigin: string) => {
      posted.push({ message, targetOrigin });
    },
  };
  parent.top = parent;
  return { parent, posted };
}

/** The frame's window: one level deep under `parent` unless overridden. */
function fakeFrame(over: Record<string, unknown> = {}) {
  const { parent, posted } = fakeParent();
  const listeners: Listener[] = [];
  const win: Record<string, unknown> = {
    parent,
    top: parent,
    location: { ancestorOrigins: [DASH] },
    addEventListener: (type: string, fn: Listener) => {
      if (type === "message") listeners.push(fn);
    },
    removeEventListener: (_type: string, fn: Listener) => {
      const at = listeners.indexOf(fn);
      if (at >= 0) listeners.splice(at, 1);
    },
    ...over,
  };
  const dispatch = (event: Record<string, unknown>) => {
    for (const fn of [...listeners]) fn(event);
  };
  return { win, parent: win.parent as Record<string, unknown>, posted, listeners, dispatch };
}

/** A fake chrome namespace: records worker requests and lets tests fire extension events. */
function fakeChrome(respond: (message: Record<string, unknown>) => unknown) {
  const sent: Record<string, unknown>[] = [];
  const runtimeListeners: Listener[] = [];
  const storageListeners: Listener[] = [];
  const c = {
    runtime: {
      id: EXT_ID,
      getManifest: () => ({ version: "0.1.0" }),
      sendMessage: async (message: Record<string, unknown>) => {
        sent.push(message);
        return respond(message);
      },
      onMessage: {
        addListener: (fn: Listener) => runtimeListeners.push(fn),
        removeListener: (fn: Listener) => runtimeListeners.splice(runtimeListeners.indexOf(fn), 1),
      },
    },
    storage: {
      onChanged: {
        addListener: (fn: Listener) => storageListeners.push(fn),
        removeListener: (fn: Listener) => storageListeners.splice(storageListeners.indexOf(fn), 1),
      },
    },
  };
  const fireRuntime = (message: unknown, sender: unknown) => {
    for (const fn of [...runtimeListeners]) fn(message, sender, () => {});
  };
  const fireStorage = (changes: unknown, areaName: string) => {
    for (const fn of [...storageListeners]) fn(changes, areaName);
  };
  return { c, sent, fireRuntime, fireStorage, runtimeListeners, storageListeners };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

const statusReply = (approved: boolean) => (message: Record<string, unknown>) =>
  message.type === "oauth-bridge:status" ? { ok: true, approved, version: "0.1.0" } : { ok: true };

test("embeddingOrigin: exactly one level deep in a plain web origin", () => {
  assert.equal(embeddingOrigin(fakeFrame().win), DASH);

  // Top-level (not embedded).
  const top: Record<string, unknown> = { location: { ancestorOrigins: [] } };
  top.parent = top;
  top.top = top;
  assert.equal(embeddingOrigin(top), null);

  // Nested two levels deep: parent is not top, and two ancestor origins.
  const { parent: outer } = fakeParent();
  const middle = { top: outer, parent: outer, postMessage() {} };
  assert.equal(
    embeddingOrigin({
      parent: middle,
      top: outer,
      location: { ancestorOrigins: [DASH, "https://outer.example"] },
    }),
    null
  );
  // parent === top but two ancestors listed, or none.
  assert.equal(
    embeddingOrigin(fakeFrame({ location: { ancestorOrigins: [DASH, DASH] } }).win),
    null
  );
  assert.equal(embeddingOrigin(fakeFrame({ location: { ancestorOrigins: [] } }).win), null);
  assert.equal(embeddingOrigin(fakeFrame({ location: {} }).win), null);

  // Non-web ancestors.
  for (const origin of ["null", "chrome-extension://abc", "file://", "https://x.example/path"]) {
    assert.equal(
      embeddingOrigin(fakeFrame({ location: { ancestorOrigins: [origin] } }).win),
      null,
      origin
    );
  }
  // Throwing accessors.
  const throwing = {
    get parent() {
      throw new Error("SecurityError");
    },
  };
  assert.equal(embeddingOrigin(throwing), null);
  assert.equal(embeddingOrigin(null), null);
});

test("acceptedParentOrigin: wrong source, mismatched origin and nested frames are rejected", () => {
  const { win, parent } = fakeFrame();
  assert.equal(acceptedParentOrigin({ source: parent, origin: DASH, data: {} }, win), DASH);
  // Another window (a sibling frame, a popup, the frame itself).
  assert.equal(acceptedParentOrigin({ source: {}, origin: DASH, data: {} }, win), null);
  assert.equal(acceptedParentOrigin({ source: win, origin: DASH, data: {} }, win), null);
  // The parent's message but from another origin than the ancestor (it navigated, or spoofing).
  assert.equal(
    acceptedParentOrigin({ source: parent, origin: "https://evil.example", data: {} }, win),
    null
  );
  // Data claiming an origin changes nothing.
  assert.equal(
    acceptedParentOrigin(
      { source: parent, origin: "https://evil.example", data: { origin: DASH } },
      win
    ),
    null
  );
  // A nested frame never accepts anything.
  const { parent: outer } = fakeParent();
  const middle = { top: outer, parent: outer };
  const nested = { parent: middle, top: outer, location: { ancestorOrigins: [DASH, DASH] } };
  assert.equal(acceptedParentOrigin({ source: middle, origin: DASH, data: {} }, nested), null);
  assert.equal(acceptedParentOrigin(null, win), null);
});

test("armForward keeps known fields and the authenticated origin only", () => {
  assert.deepEqual(
    armForward(
      {
        source: "omniroute-dashboard",
        type: "oauth-bridge:arm",
        requestId: "r1",
        provider: "codex",
        state: "s",
        redirectUri: "http://localhost:1455/auth/callback",
        origin: "https://evil.example",
        dashboardOrigin: "https://evil.example",
      },
      DASH
    ),
    {
      type: "oauth-bridge:arm",
      origin: DASH,
      requestId: "r1",
      provider: "codex",
      state: "s",
      redirectUri: "http://localhost:1455/auth/callback",
    }
  );
});

test("startBridge does nothing when not embedded one level deep", () => {
  const { c, sent } = fakeChrome(statusReply(true));
  const top: Record<string, unknown> = { location: { ancestorOrigins: [] } };
  top.parent = top;
  top.top = top;
  assert.equal(startBridge(top, c), null);
  assert.equal(startBridge(fakeFrame({ location: { ancestorOrigins: [] } }).win, c), null);
  assert.deepEqual(sent, []);
});

test("startBridge announces ready with the approval state to the ancestor origin only", async () => {
  for (const approved of [false, true]) {
    const frame = fakeFrame();
    const chrome = fakeChrome(statusReply(approved));
    const bridge = startBridge(frame.win, chrome.c);
    assert.ok(bridge);
    await bridge.settled;
    assert.deepEqual(chrome.sent, [{ type: "oauth-bridge:status", origin: DASH }]);
    assert.deepEqual(frame.posted, [
      {
        message: { source: "omniroute-oauth-bridge", type: "ready", version: "0.1.0", approved },
        targetOrigin: DASH,
      },
    ]);
    bridge.stop();
  }
});

test("startBridge reports not approved when the worker fails", async () => {
  const frame = fakeFrame();
  const chrome = fakeChrome(() => {
    throw new Error("context invalidated");
  });
  const bridge = startBridge(frame.win, chrome.c);
  await bridge!.settled;
  assert.equal(frame.posted[0].message.approved, false);
});

test("arm messages are forwarded with event.origin and replies go back to that origin", async () => {
  const frame = fakeFrame();
  const replies = new Map<string, unknown>([
    ["ok", { ok: true }],
    ["bad", { ok: false, reason: "redirect-not-allowed" }],
    ["none", undefined],
  ]);
  const chrome = fakeChrome((m) =>
    m.type === "oauth-bridge:status"
      ? { ok: true, approved: true }
      : replies.get(String(m.requestId))
  );
  const bridge = startBridge(frame.win, chrome.c);
  await bridge!.settled;
  frame.posted.length = 0;
  chrome.sent.length = 0;

  const armData = (requestId: string, extra: Record<string, unknown> = {}) => ({
    source: "omniroute-dashboard",
    type: "oauth-bridge:arm",
    requestId,
    provider: "codex",
    state: "s",
    redirectUri: "http://localhost:1455/auth/callback",
    ...extra,
  });
  frame.dispatch({ source: frame.parent, origin: DASH, data: armData("ok", { origin: "x" }) });
  frame.dispatch({ source: frame.parent, origin: DASH, data: armData("bad") });
  frame.dispatch({ source: frame.parent, origin: DASH, data: armData("none") });
  await flush();
  assert.deepEqual(
    chrome.sent.map((m) => [m.requestId, m.origin]),
    [
      ["ok", DASH],
      ["bad", DASH],
      ["none", DASH],
    ]
  );
  assert.deepEqual(
    frame.posted.map((p) => [
      p.targetOrigin,
      p.message.type,
      p.message.requestId,
      p.message.reason,
    ]),
    [
      [DASH, "oauth-bridge:armed", "ok", undefined],
      [DASH, "oauth-bridge:error", "bad", "redirect-not-allowed"],
      [DASH, "oauth-bridge:error", "none", "internal-error"],
    ]
  );
});

test("messages from the wrong source or origin, or not from the dashboard, are ignored", async () => {
  const frame = fakeFrame();
  const chrome = fakeChrome(statusReply(true));
  const bridge = startBridge(frame.win, chrome.c);
  await bridge!.settled;
  frame.posted.length = 0;
  chrome.sent.length = 0;
  const data = {
    source: "omniroute-dashboard",
    type: "oauth-bridge:arm",
    requestId: "r",
    provider: "codex",
    state: "s",
    redirectUri: "http://localhost:1455/auth/callback",
  };
  frame.dispatch({ source: {}, origin: DASH, data });
  frame.dispatch({ source: frame.parent, origin: "https://evil.example", data });
  frame.dispatch({ source: frame.parent, origin: DASH, data: { ...data, source: "other" } });
  frame.dispatch({ source: frame.parent, origin: DASH, data: "oauth-bridge:arm" });
  frame.dispatch({ source: frame.parent, origin: DASH, data: null });
  await flush();
  assert.deepEqual(chrome.sent, []);
  assert.deepEqual(frame.posted, []);

  // A status request from the parent re-announces ready.
  frame.dispatch({
    source: frame.parent,
    origin: DASH,
    data: { source: "omniroute-dashboard", type: "oauth-bridge:status" },
  });
  await flush();
  assert.deepEqual(chrome.sent, [{ type: "oauth-bridge:status", origin: DASH }]);
  assert.equal(frame.posted[0].message.type, "ready");
});

test("an approval broadcast for this origin posts approved once; others are ignored", async () => {
  const frame = fakeFrame();
  const chrome = fakeChrome(statusReply(false));
  const bridge = startBridge(frame.win, chrome.c);
  await bridge!.settled;
  frame.posted.length = 0;
  const own = { id: EXT_ID };

  chrome.fireRuntime({ type: "origin-approved", origin: "https://other.example" }, own);
  chrome.fireRuntime({ type: "origin-approved", origin: DASH }, { id: "other-extension" });
  chrome.fireRuntime({ type: "something-else", origin: DASH }, own);
  assert.deepEqual(frame.posted, []);

  chrome.fireRuntime({ type: "origin-approved", origin: DASH }, own);
  // storage.onChanged for the same approval does not post a second time.
  chrome.fireStorage({ approvedOrigins: { newValue: [DASH] } }, "local");
  chrome.fireRuntime({ type: "origin-approved", origin: DASH }, own);
  assert.deepEqual(frame.posted, [
    {
      message: { source: "omniroute-oauth-bridge", type: "approved", version: "0.1.0" },
      targetOrigin: DASH,
    },
  ]);

  // Removing the origin in the popup reports ready(approved: false).
  chrome.fireStorage({ approvedOrigins: { newValue: [] } }, "local");
  assert.deepEqual(frame.posted[1].message, {
    source: "omniroute-oauth-bridge",
    type: "ready",
    version: "0.1.0",
    approved: false,
  });
  bridge!.stop();
  assert.equal(chrome.runtimeListeners.length, 0);
  assert.equal(chrome.storageListeners.length, 0);
});

test("storage.onChanged alone is enough to report the approval", async () => {
  const frame = fakeFrame();
  const chrome = fakeChrome(statusReply(false));
  const bridge = startBridge(frame.win, chrome.c);
  await bridge!.settled;
  frame.posted.length = 0;
  chrome.fireStorage({ approvedOrigins: { newValue: ["https://other.example"] } }, "local");
  chrome.fireStorage({ approvedOrigins: { newValue: [DASH] } }, "sync");
  chrome.fireStorage({ armed: { newValue: {} } }, "local");
  assert.deepEqual(frame.posted, []);
  chrome.fireStorage({ approvedOrigins: { newValue: ["https://other.example", DASH] } }, "local");
  assert.equal(frame.posted.length, 1);
  assert.equal(frame.posted[0].message.type, "approved");
  assert.equal(frame.posted[0].targetOrigin, DASH);
});
