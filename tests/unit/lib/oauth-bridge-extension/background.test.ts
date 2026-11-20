import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

interface Rule {
  id: number;
  action: { redirect: { regexSubstitution: string } };
  condition: { regexFilter: string };
}
interface Mock {
  local: Map<string, unknown>;
  session: Map<string, unknown>;
  rules: Rule[];
  alarms: Map<string, unknown>;
  removedTabs: number[];
}

const mock: Mock = {
  local: new Map(),
  session: new Map(),
  rules: [],
  alarms: new Map(),
  removedTabs: [],
};

const EXT_ID = "gmckjokkoeeokoldknjmaipdbnceldil";
const EXT_BASE = `chrome-extension://${EXT_ID}/`;

function area(store: Map<string, unknown>) {
  return {
    get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
    },
  };
}

// No runtime.onMessage on purpose: the module must not register listeners.
(globalThis as unknown as Record<string, unknown>).chrome = {
  runtime: {
    id: EXT_ID,
    getManifest: () => ({ version: "0.1.0" }),
    getURL: (p: string) => `${EXT_BASE}${p}`,
  },
  storage: { local: area(mock.local), session: area(mock.session) },
  declarativeNetRequest: {
    getSessionRules: async () => structuredClone(mock.rules),
    updateSessionRules: async (o: { addRules?: Rule[]; removeRuleIds?: number[] }) => {
      const remove = new Set(o.removeRuleIds ?? []);
      mock.rules = mock.rules.filter((r) => !remove.has(r.id));
      mock.rules.push(...(o.addRules ?? []));
    },
  },
  alarms: {
    create: async (name: string, info: unknown) => {
      mock.alarms.set(name, info);
    },
    clear: async (name: string) => mock.alarms.delete(name),
    getAll: async () => [...mock.alarms.keys()].map((name) => ({ name })),
  },
  tabs: {
    remove: async (id: number) => {
      mock.removedTabs.push(id);
    },
  },
};

const bg = await import("../../../../packages/oauth-bridge-extension/src/background.js");
const { escapeRegex: bg_escape } =
  await import("../../../../packages/oauth-bridge-extension/src/rules.js");

const ORIGIN = "http://localhost:20128";
const CODEX = "http://localhost:1455/auth/callback";
const CLAUDE = "https://platform.claude.com/oauth/code/callback";
// A bridge.html frame embedded in tab 5 (sender.origin is the extension's, never the page's).
const sender = {
  id: EXT_ID,
  url: `${EXT_BASE}bridge.html`,
  origin: `chrome-extension://${EXT_ID}`,
  frameId: 3,
  tab: { id: 5 },
};

function reset() {
  mock.local.clear();
  mock.session.clear();
  mock.rules = [];
  mock.alarms.clear();
  mock.removedTabs = [];
  mock.local.set("approvedOrigins", [ORIGIN]);
}

function msg(over: Record<string, unknown> = {}) {
  return {
    type: "oauth-bridge:arm",
    requestId: "req1",
    provider: "codex",
    state: "st4te",
    redirectUri: CODEX,
    origin: ORIGIN,
    ...over,
  };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

async function committedClose(t: TestContext, details: Record<string, unknown>): Promise<number[]> {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await bg.handleCommitted(details);
  t.mock.timers.tick(3000);
  await flush();
  return [...mock.removedTabs];
}

const commit = (state: string, extra: Record<string, unknown> = {}) => ({
  frameId: 0,
  tabId: 9,
  url: `${ORIGIN}/callback?code=c&state=${state}`,
  transitionQualifiers: ["server_redirect"],
  ...extra,
});

test("isBridgeFrameSender accepts only this extension's bridge.html as an embedded frame", () => {
  assert.equal(bg.isBridgeFrameSender(sender), true);
  assert.equal(bg.isBridgeFrameSender({ ...sender, url: `${EXT_BASE}bridge.html?x=1` }), true);
  const rejected: unknown[] = [
    undefined,
    null,
    {},
    { ...sender, id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { ...sender, id: undefined },
    // Top-level bridge.html (not embedded) and a missing frameId.
    { ...sender, frameId: 0 },
    { ...sender, frameId: undefined },
    // Another page of this extension, a look-alike path, a web page and another extension.
    { ...sender, url: `${EXT_BASE}approve.html` },
    { ...sender, url: `${EXT_BASE}bridge.html.evil` },
    { ...sender, url: `${EXT_BASE}src/bridge.html` },
    { ...sender, url: `${ORIGIN}/bridge.html` },
    { ...sender, url: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/bridge.html" },
    { ...sender, url: "not a url" },
    { ...sender, url: undefined },
  ];
  for (const s of rejected) assert.equal(bg.isBridgeFrameSender(s), false, JSON.stringify(s));
});

test("arm from anything but a bridge frame is rejected", async () => {
  reset();
  const unapproved = { ok: false, reason: "unapproved-origin" };
  // The old content-script shape: a sender with the page's origin.
  assert.deepEqual(await bg.handleArm(msg(), { origin: ORIGIN, tab: { id: 5 } }), unapproved);
  assert.deepEqual(await bg.handleArm(msg(), {}), unapproved);
  assert.deepEqual(await bg.handleArm(msg(), { ...sender, frameId: 0 }), unapproved);
  assert.deepEqual(
    await bg.handleArm(msg(), { ...sender, url: `${EXT_BASE}approve.html` }),
    unapproved
  );
  assert.equal(mock.rules.length, 0);
});

test("arm requires an approved, valid origin from the bridge", async () => {
  reset();
  const unapproved = { ok: false, reason: "unapproved-origin" };
  assert.deepEqual(await bg.handleArm(msg({ origin: "http://evil.example" }), sender), unapproved);
  assert.deepEqual(await bg.handleArm(msg({ origin: undefined }), sender), unapproved);
  assert.deepEqual(await bg.handleArm(msg({ origin: `${ORIGIN}/path` }), sender), unapproved);
  mock.local.set("approvedOrigins", []);
  assert.deepEqual(await bg.handleArm(msg(), sender), unapproved);
  assert.equal(mock.rules.length, 0);
});

test("ignores a dashboardOrigin in the payload", async () => {
  reset();
  const r = await bg.handleArm(msg({ dashboardOrigin: "http://evil.example" }), sender);
  assert.deepEqual(r, { ok: true });
  assert.equal(mock.rules[0].action.redirect.regexSubstitution, `${ORIGIN}/callback?\\1`);
  assert.equal(
    (Object.values(mock.session.get("armed") as object)[0] as { tabId: number }).tabId,
    5
  );
});

test("bridge status reports approval for the frame's origin only", async () => {
  reset();
  const status = (origin: unknown, from: unknown = sender) =>
    bg.handleBridgeStatus({ type: "oauth-bridge:status", origin }, from);
  assert.deepEqual(await status(ORIGIN), { ok: true, approved: true, version: "0.1.0" });
  assert.deepEqual(await status("https://other.example"), {
    ok: true,
    approved: false,
    version: "0.1.0",
  });
  assert.deepEqual(await status("javascript:alert(1)"), { ok: false, reason: "invalid-message" });
  assert.deepEqual(await status(ORIGIN, { ...sender, frameId: 0 }), {
    ok: false,
    reason: "unapproved-origin",
  });
  assert.deepEqual(await status(ORIGIN, { origin: ORIGIN }), {
    ok: false,
    reason: "unapproved-origin",
  });
  assert.deepEqual(await bg.handleBridgeStatus({ type: "x", origin: ORIGIN }, sender), {
    ok: false,
    reason: "invalid-message",
  });
});

test("rejects non-allowed redirect URIs and invalid messages", async () => {
  reset();
  const bad = { ok: false, reason: "redirect-not-allowed" };
  assert.deepEqual(
    await bg.handleArm(msg({ redirectUri: "https://evil.example/auth/callback" }), sender),
    bad
  );
  assert.deepEqual(
    await bg.handleArm(msg({ provider: "claude", redirectUri: "https://evil.example/x" }), sender),
    bad
  );
  assert.deepEqual(await bg.handleArm(msg({ state: "" }), sender), {
    ok: false,
    reason: "invalid-message",
  });
  assert.deepEqual(await bg.handleArm({ type: "x", origin: ORIGIN }, sender), {
    ok: false,
    reason: "invalid-message",
  });
  assert.equal(mock.rules.length, 0);
});

test("arm accepts a loopback URI that is not in the list", async () => {
  reset();
  const uri = "http://127.0.0.1:4242/new/path";
  assert.deepEqual(await bg.handleArm(msg({ redirectUri: uri }), sender), { ok: true });
  assert.equal(mock.rules.length, 1);
  assert.ok(mock.rules[0].condition.regexFilter.startsWith(`^${bg_escape(uri)}`));
});

test("arm rejects a redirectUri on the dashboard origin itself", async () => {
  reset();
  assert.deepEqual(
    await bg.handleArm(msg({ redirectUri: "http://localhost:20128/callback" }), sender),
    { ok: false, reason: "redirect-not-allowed" }
  );
  assert.equal(mock.rules.length, 0);
});

test("arm adds one rule and an alarm; re-arming replaces it", async () => {
  reset();
  assert.deepEqual(await bg.handleArm(msg(), sender), { ok: true });
  assert.equal(mock.rules.length, 1);
  const id = mock.rules[0].id;
  assert.equal(mock.rules[0].action.redirect.regexSubstitution, `${ORIGIN}/callback?\\1`);
  assert.deepEqual(mock.alarms.get(`oauth-bridge-rule-${id}`), { delayInMinutes: 10 });

  assert.deepEqual(await bg.handleArm(msg(), sender), { ok: true });
  assert.equal(mock.rules.length, 1);
  assert.equal(mock.alarms.size, 1);
});

test("committed matching callback removes rule and closes tab after 3s", async (t) => {
  reset();
  await bg.handleArm(msg(), sender);
  const id = mock.rules[0].id;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await bg.handleCommitted(commit("st4te"));
  assert.equal(mock.rules.length, 0);
  assert.equal(mock.alarms.has(`oauth-bridge-rule-${id}`), false);
  assert.deepEqual(mock.removedTabs, []);
  t.mock.timers.tick(2999);
  await flush();
  assert.deepEqual(mock.removedTabs, []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(mock.removedTabs, [9]);
});

test("non-matching commits keep the rule and close nothing", async (t) => {
  reset();
  await bg.handleArm(msg(), sender);
  const cases = [
    commit("other"),
    commit("st4te", { url: "http://localhost:3000/callback?state=st4te" }),
    commit("st4te", { url: `${ORIGIN}/other?state=st4te` }),
    commit("st4te", { frameId: 1 }),
  ];
  for (const c of cases) assert.deepEqual(await committedClose(t, c), []);
  assert.equal(mock.rules.length, 1);
});

test("commit without redirect qualifiers removes rule but keeps tab", async (t) => {
  reset();
  await bg.handleArm(msg(), sender);
  const closed = await committedClose(t, commit("st4te", { transitionQualifiers: [] }));
  assert.deepEqual(closed, []);
  assert.equal(mock.rules.length, 0);
});

test("beforeNavigate to the redirect URI marks the tab so it closes", async (t) => {
  reset();
  await bg.handleArm(msg(), sender);
  await bg.handleBeforeNavigate({
    frameId: 0,
    tabId: 9,
    url: `${CODEX}?code=c&state=st4te`,
  });
  const closed = await committedClose(t, commit("st4te", { transitionQualifiers: [] }));
  assert.deepEqual(closed, [9]);
  assert.equal(mock.rules.length, 0);
});

test("alarm removes the matching rule; unrelated alarms do nothing", async () => {
  reset();
  await bg.handleArm(msg(), sender);
  const id = mock.rules[0].id;
  await bg.handleAlarm({ name: "something-else" });
  await bg.handleAlarm({ name: "oauth-bridge-rule-abc" });
  assert.equal(mock.rules.length, 1);
  await bg.handleAlarm({ name: `oauth-bridge-rule-${id}` });
  assert.equal(mock.rules.length, 0);
  assert.equal(mock.alarms.size, 0);
});

test("clearStaleRules removes all rules and our alarms only", async () => {
  reset();
  await bg.handleArm(msg(), sender);
  await bg.handleArm(msg({ provider: "claude", redirectUri: CLAUDE, state: "other" }), sender);
  assert.equal(mock.rules.length, 2);
  mock.alarms.set("unrelated", {});
  await bg.clearStaleRules();
  assert.equal(mock.rules.length, 0);
  assert.deepEqual([...mock.alarms.keys()], ["unrelated"]);
  assert.deepEqual(mock.session.get("armed"), {});
});

const ZED_ALLOWED = [
  {
    provider: "zed-hosted",
    kind: "dashboard-port-loopback",
    redirectUri: "http://127.0.0.1:{port}/",
    stateMode: "appended",
    requiredParams: ["user_id", "access_token"],
  },
  { provider: "codex", kind: "fixed-loopback", redirectUri: CODEX },
];
const ZED_URI = "http://127.0.0.1:58443/";
const zedMsg = (over: Record<string, unknown> = {}) =>
  msg({ provider: "zed-hosted", redirectUri: ZED_URI, state: "zst4te", ...over });
const armZed = (over: Record<string, unknown> = {}) =>
  bg.handleArm(zedMsg(over), sender, { allowed: ZED_ALLOWED });
const zedRules = () =>
  mock.rules.filter((r) => r.action.redirect.regexSubstitution.includes("/callback?state="));

test("arming zed builds the appended-state rule", async () => {
  reset();
  assert.deepEqual(await armZed(), { ok: true });
  assert.equal(mock.rules.length, 1);
  const rule = mock.rules[0];
  assert.equal(rule.action.redirect.regexSubstitution, `${ORIGIN}/callback?state=zst4te&\\1`);
  const re = new RegExp(rule.condition.regexFilter);
  assert.ok(re.test(`${ZED_URI}?user_id=1&access_token=abc`));
  assert.ok(re.test(`${ZED_URI}?access_token=abc&user_id=1`));
  assert.equal(re.test(`${ZED_URI}?user_id=1`), false);
  const armed = mock.session.get("armed") as Record<string, Record<string, unknown>>;
  assert.equal(armed[rule.id].provider, "zed-hosted");
  assert.equal(armed[rule.id].stateMode, "appended");
  assert.deepEqual(mock.alarms.get(`oauth-bridge-rule-${rule.id}`), { delayInMinutes: 10 });
});

test("arming zed rejects a loopback URI that is not the exact allow-list entry", async () => {
  reset();
  const bad = { ok: false, reason: "redirect-not-allowed" };
  assert.deepEqual(await armZed({ redirectUri: "http://127.0.0.1:58443/other" }), bad);
  assert.deepEqual(await armZed({ redirectUri: "http://localhost:58443/" }), bad);
  assert.equal(mock.rules.length, 0);
});

test("arming zed twice with different states leaves exactly one zed rule", async () => {
  reset();
  assert.deepEqual(await armZed({ state: "first" }), { ok: true });
  const firstId = mock.rules[0].id;
  assert.deepEqual(await armZed({ state: "second" }), { ok: true });
  assert.equal(zedRules().length, 1);
  assert.equal(mock.rules.length, 1);
  assert.ok(mock.rules[0].action.redirect.regexSubstitution.includes("?state=second&"));
  assert.equal(mock.alarms.has(`oauth-bridge-rule-${firstId}`), false);
  assert.equal(mock.alarms.size, 1);
  const armed = mock.session.get("armed") as Record<string, unknown>;
  assert.deepEqual(Object.keys(armed), [String(mock.rules[0].id)]);
});

test("a non-appended provider is unaffected by zed arming", async () => {
  reset();
  assert.deepEqual(await bg.handleArm(msg(), sender, { allowed: ZED_ALLOWED }), { ok: true });
  assert.deepEqual(await armZed({ state: "z1" }), { ok: true });
  assert.deepEqual(await armZed({ state: "z2" }), { ok: true });
  assert.equal(mock.rules.length, 2);
  const codexRule = mock.rules.find((r) => r.action.redirect.regexSubstitution.endsWith("\\1"));
  assert.ok(codexRule);
  assert.ok(new RegExp(codexRule.condition.regexFilter).test(`${CODEX}?code=c&state=st4te`));
  const armed = mock.session.get("armed") as Record<string, Record<string, unknown>>;
  assert.equal(armed[codexRule.id].stateMode, "query");
});

test("zed callback commit with the appended state disarms and closes the tab", async (t) => {
  reset();
  await armZed();
  const id = mock.rules[0].id;
  const closed = await committedClose(t, {
    frameId: 0,
    tabId: 9,
    url: `${ORIGIN}/callback?user_id=1&access_token=abc&state=zst4te`,
    transitionQualifiers: ["server_redirect"],
  });
  assert.deepEqual(closed, [9]);
  assert.equal(mock.rules.length, 0);
  assert.equal(mock.alarms.has(`oauth-bridge-rule-${id}`), false);
  assert.deepEqual(mock.session.get("armed"), {});
});

test("beforeNavigate to the zed redirect with the required params marks the tab", async (t) => {
  reset();
  await armZed();
  await bg.handleBeforeNavigate({ frameId: 0, tabId: 4, url: `${ZED_URI}?user_id=1` });
  await bg.handleBeforeNavigate({
    frameId: 0,
    tabId: 9,
    url: `${ZED_URI}?access_token=abc&user_id=1`,
  });
  const armed = mock.session.get("armed") as Record<string, Record<string, unknown>>;
  assert.equal(Object.values(armed)[0].redirectedTabId, 9);
  const closed = await committedClose(t, {
    frameId: 0,
    tabId: 9,
    url: `${ORIGIN}/callback?access_token=abc&user_id=1&state=zst4te`,
    transitionQualifiers: [],
  });
  assert.deepEqual(closed, [9]);
});
