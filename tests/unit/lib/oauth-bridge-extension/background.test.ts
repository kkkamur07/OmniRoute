import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

interface Rule {
  id: number;
  action: { redirect: { regexSubstitution: string } };
  condition: { regexFilter: string };
}
interface Script {
  id: string;
  matches: string[];
}
interface Mock {
  local: Map<string, unknown>;
  session: Map<string, unknown>;
  rules: Rule[];
  alarms: Map<string, unknown>;
  removedTabs: number[];
  granted: Set<string>;
  scripts: Script[];
  scriptCalls: string[];
}

const mock: Mock = {
  local: new Map(),
  session: new Map(),
  rules: [],
  alarms: new Map(),
  removedTabs: [],
  granted: new Set(),
  scripts: [],
  scriptCalls: [],
};

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
  runtime: { getManifest: () => ({ version: "0.1.0" }) },
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
  permissions: {
    contains: async (q: { origins: string[] }) => q.origins.every((o) => mock.granted.has(o)),
  },
  scripting: {
    getRegisteredContentScripts: async () => structuredClone(mock.scripts),
    registerContentScripts: async (s: Script[]) => {
      mock.scriptCalls.push("register");
      mock.scripts = structuredClone(s);
    },
    updateContentScripts: async (s: Script[]) => {
      mock.scriptCalls.push("update");
      mock.scripts = structuredClone(s);
    },
    unregisterContentScripts: async () => {
      mock.scriptCalls.push("unregister");
      mock.scripts = [];
    },
  },
};

const bg = await import("../../../../packages/oauth-bridge-extension/src/background.js");
const { escapeRegex: bg_escape } =
  await import("../../../../packages/oauth-bridge-extension/src/rules.js");

const ORIGIN = "http://localhost:20128";
const CODEX = "http://localhost:1455/auth/callback";
const CLAUDE = "https://platform.claude.com/oauth/code/callback";
const sender = { origin: ORIGIN, tab: { id: 5 } };

function reset() {
  mock.local.clear();
  mock.session.clear();
  mock.rules = [];
  mock.alarms.clear();
  mock.removedTabs = [];
  mock.granted.clear();
  mock.scripts = [];
  mock.scriptCalls = [];
  mock.local.set("approvedOrigins", [ORIGIN]);
}

function msg(over: Record<string, unknown> = {}) {
  return {
    type: "oauth-bridge:arm",
    requestId: "req1",
    provider: "codex",
    state: "st4te",
    redirectUri: CODEX,
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

test("rejects unapproved or missing sender origin", async () => {
  reset();
  assert.deepEqual(await bg.handleArm(msg(), { origin: "http://evil.example" }), {
    ok: false,
    reason: "unapproved-origin",
  });
  assert.deepEqual(await bg.handleArm(msg(), {}), { ok: false, reason: "unapproved-origin" });
  assert.equal(mock.rules.length, 0);
});

test("ignores a dashboardOrigin in the payload", async () => {
  reset();
  const r = await bg.handleArm(msg({ dashboardOrigin: "http://evil.example" }), sender);
  assert.deepEqual(r, { ok: true });
  assert.equal(mock.rules[0].action.redirect.regexSubstitution, `${ORIGIN}/callback?\\1`);
  reset();
  const r2 = await bg.handleArm(msg({ dashboardOrigin: ORIGIN }), {
    origin: "http://evil.example",
  });
  assert.equal(r2.ok, false);
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
  assert.deepEqual(await bg.handleArm({ type: "x" }, sender), {
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

test("syncContentScripts registers for granted origins and unregisters when none", async () => {
  reset();
  mock.local.set("approvedOrigins", [ORIGIN, "https://dash.example.com"]);
  mock.granted.add(`${ORIGIN}/*`);
  await bg.syncContentScripts();
  assert.deepEqual(mock.scriptCalls, ["register"]);
  assert.deepEqual(mock.scripts[0].matches, [`${ORIGIN}/*`]);

  mock.granted.add("https://dash.example.com/*");
  await bg.syncContentScripts();
  assert.deepEqual(mock.scriptCalls, ["register", "update"]);
  assert.deepEqual(mock.scripts[0].matches, [`${ORIGIN}/*`, "https://dash.example.com/*"]);

  mock.granted.clear();
  await bg.syncContentScripts();
  assert.deepEqual(mock.scriptCalls, ["register", "update", "unregister"]);
  assert.equal(mock.scripts.length, 0);
});
