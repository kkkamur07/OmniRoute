// OpenAI-format clients calling a Claude target lost their own cache_control markers: the
// translator rebuilt text parts without them and shipped its own tail marker instead, so the
// varying suffix was rewritten on every call and nothing was ever read back (measured live:
// chat route write 10,944 then write 10,945, /v1/messages write 10,907 then read 10,907).
import { after, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-client-cache-markers-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { invalidateCacheControlSettingsCache } =
  await import("../../src/lib/cacheControlSettings.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { getExecutor } = await import("../../open-sse/executors/index.ts");
const { shouldPreserveCacheControl } = await import("../../open-sse/utils/cacheControlPolicy.ts");

type Rec = Record<string, unknown>;

const MODEL = "claude-sonnet-5-5";
const MARK = { type: "ephemeral" };
const originalFetch = globalThis.fetch;

/** Same shape as the live reproduction, with a middle step that varies per call. */
function liveShapeBody(middle = "middle step A"): Rec {
  return {
    model: MODEL,
    max_tokens: 64,
    messages: [
      { role: "system", content: "You are terse." },
      {
        role: "user",
        content: [{ type: "text", text: "long stable document", cache_control: { ...MARK } }],
      },
      { role: "assistant", content: "Read." },
      { role: "user", content: middle },
      { role: "assistant", content: "Understood." },
      { role: "user", content: "Answer yes or no." },
    ],
  };
}

function translate(body: Rec, provider: string | null = "claude", preserve = true): Rec {
  return translateRequest(
    "openai",
    "claude",
    MODEL,
    structuredClone(body),
    false,
    null,
    provider,
    null,
    {
      preserveCacheControl: preserve,
    }
  ) as Rec;
}

/** Every marker on the final body, in wire order, as "<where>:<text or name>" => marker. */
function markers(body: Rec): Array<[string, unknown]> {
  const found: Array<[string, unknown]> = [];
  for (const tool of (body.tools as Rec[]) ?? []) {
    if (tool.cache_control) found.push([`tool:${tool.name}`, tool.cache_control]);
  }
  for (const block of (body.system as Rec[]) ?? []) {
    if (block.cache_control) found.push([`system:${block.text}`, block.cache_control]);
  }
  for (const message of (body.messages as Array<{ role: string; content: Rec[] }>) ?? []) {
    for (const block of message.content) {
      if (block.cache_control) {
        const label = block.text ?? block.type;
        found.push([`${message.role}:${label}`, block.cache_control]);
      }
    }
  }
  return found;
}

describe("A: client markers survive the openai to claude translation", () => {
  test("marked user text keeps its marker, ttl included", () => {
    const body = liveShapeBody();
    const out = translate(body);
    assert.deepEqual(markers(out), [["user:long stable document", MARK]]);
  });

  test("user and assistant text parts keep their own markers verbatim", () => {
    const out = translate({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "u1", cache_control: { type: "ephemeral", ttl: "1h" } },
            { type: "text", text: "u1 tail" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "a1", cache_control: { type: "ephemeral", ttl: "5m" } }],
        },
        { role: "user", content: "u2" },
      ],
    });
    assert.deepEqual(markers(out), [
      ["user:u1", { type: "ephemeral", ttl: "1h" }],
      ["assistant:a1", { type: "ephemeral", ttl: "5m" }],
    ]);
  });

  test("markers survive merging of consecutive same-role messages", () => {
    const out = translate({
      model: MODEL,
      messages: [
        { role: "user", content: [{ type: "text", text: "u1", cache_control: { ...MARK } }] },
        { role: "user", content: [{ type: "text", text: "u2", cache_control: { ...MARK } }] },
        { role: "user", content: "u3" },
      ],
    });
    const messages = out.messages as Array<{ content: Rec[] }>;
    assert.equal(messages.length, 1, "consecutive user turns merge into one message");
    assert.equal(messages[0].content.length, 3);
    assert.deepEqual(markers(out), [
      ["user:u1", MARK],
      ["user:u2", MARK],
    ]);
  });

  test("a marked system part splits at the marker, so what follows stays out of the prefix", () => {
    const out = translate({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "stable one" },
            { type: "text", text: "stable two", cache_control: { type: "ephemeral", ttl: "1h" } },
            { type: "text", text: "varying" },
          ],
        },
        { role: "system", content: "second message" },
        { role: "user", content: "hi" },
      ],
    });
    const system = out.system as Rec[];
    assert.deepEqual(system[0], {
      type: "text",
      text: "stable one\nstable two",
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
    assert.equal(system.length, 2);
    assert.equal(system[1].cache_control, undefined);
    assert.match(
      String(system[1].text),
      /^varying\nsecond message\nYou must respond with valid JSON/
    );
  });

  test("a native body.system block keeps its marker and suppresses the gateway ones", () => {
    const out = translate({
      model: MODEL,
      system: [{ type: "text", text: "native", cache_control: { ...MARK } }],
      messages: [
        { role: "system", content: "extra" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    });
    assert.deepEqual(markers(out), [["system:native", MARK]]);
    assert.equal((out.system as Rec[]).length, 2);
  });

  test("a marker on an image part survives, and a marked empty text part counts for nothing", () => {
    const image = translate({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
              cache_control: { ...MARK },
            },
          ],
        },
      ],
    });
    assert.deepEqual(markers(image), [["user:image", MARK]]);

    const empty = translate({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "", cache_control: { ...MARK } },
            { type: "text", text: "u1" },
          ],
        },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    });
    assert.deepEqual(markers(empty), [["assistant:a1", MARK]], "gateway tail still applies");
  });

  test("a client marker on a tool definition survives", () => {
    const out = translate({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          cache_control: { type: "ephemeral", ttl: "1h" },
          function: { name: "first", parameters: { type: "object", properties: {} } },
        },
        {
          type: "function",
          function: { name: "last", parameters: { type: "object", properties: {} } },
        },
      ],
    });
    assert.deepEqual(markers(out), [["tool:proxy_first", { type: "ephemeral", ttl: "1h" }]]);
  });
});

describe("B: a client marker turns the gateway's own markers off", () => {
  test("no tail, system or tool marker is added next to a client marker", () => {
    const body = liveShapeBody();
    body.tools = [
      {
        type: "function",
        function: { name: "lookup", parameters: { type: "object", properties: {} } },
      },
    ];
    const out = translate(body);
    assert.deepEqual(markers(out), [["user:long stable document", MARK]]);
    assert.deepEqual(out.system, [{ type: "text", text: "You are terse." }]);
  });

  test("a client marker on a tool_result also counts as the client's own", () => {
    const out = translate({
      model: MODEL,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "r", cache_control: { ...MARK } },
        { role: "assistant", content: "done" },
        { role: "user", content: "next" },
      ],
    });
    assert.deepEqual(markers(out), [["user:tool_result", MARK]]);
  });

  test("the cached prefix is identical across calls whose middle step varies", () => {
    const first = translate(liveShapeBody("middle step A"));
    const second = translate(liveShapeBody("middle step B"));
    const prefix = (body: Rec) => ({
      system: body.system,
      head: (body.messages as Rec[]).slice(0, 1),
    });
    assert.deepEqual(prefix(first), prefix(second));
    assert.notDeepEqual(first.messages, second.messages);
    assert.deepEqual(markers(first), markers(second));
  });

  test("no gateway marker can land after a client 1h breakpoint and create a TTL order error", () => {
    const out = translate({
      model: MODEL,
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [{ type: "text", text: "u1", cache_control: { type: "ephemeral", ttl: "1h" } }],
        },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object", properties: {} } },
        },
      ],
    });
    assert.deepEqual(markers(out), [["user:u1", { type: "ephemeral", ttl: "1h" }]]);
  });
});

describe("C: at most 4 breakpoints on the final request", () => {
  test("more than 4 client markers keep the last 4 (existing enforceCacheControlBlockLimit rule)", () => {
    const out = translate({
      model: MODEL,
      messages: [
        { role: "system", content: [{ type: "text", text: "s1", cache_control: { ...MARK } }] },
        ...[1, 2, 3, 4, 5].flatMap((n) => [
          { role: "user", content: [{ type: "text", text: `u${n}`, cache_control: { ...MARK } }] },
          { role: "assistant", content: `a${n}` },
        ]),
        { role: "user", content: "last" },
      ],
    });
    assert.deepEqual(
      markers(out).map(([where]) => where),
      ["user:u2", "user:u3", "user:u4", "user:u5"]
    );
  });

  test("the cap counts tools and system too", () => {
    const out = translate({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "s1", cache_control: { ...MARK } },
            { type: "text", text: "s2", cache_control: { ...MARK } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "u1", cache_control: { ...MARK } },
            { type: "text", text: "u2", cache_control: { ...MARK } },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          cache_control: { ...MARK },
          function: { name: "t", parameters: { type: "object", properties: {} } },
        },
      ],
    });
    assert.equal(markers(out).length, 4);
    assert.ok(!markers(out).some(([where]) => where === "system:s1"), "the earliest one goes");
  });
});

const NO_MARKER_BODY: Rec = {
  model: MODEL,
  max_tokens: 64,
  messages: [
    {
      role: "system",
      content: [
        { type: "text", text: "sys one" },
        { type: "text", text: "sys two" },
      ],
    },
    { role: "system", content: "sys three" },
    { role: "user", content: [{ type: "text", text: "u1" }] },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "lookup",
        description: "d",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
};

// Captured from the translator before this fix, byte for byte.
const TOOLS_JSON =
  '"tools":[{"name":"proxy_lookup","description":"d","input_schema":{"type":"object","properties":{},"additionalProperties":true},"cache_control":{"type":"ephemeral","ttl":"1h"}}]';
const SYSTEM_JSON =
  '"system":[{"type":"text","text":"sys one\\nsys two\\nsys three","cache_control":{"type":"ephemeral","ttl":"1h"}}]';
const HEAD_JSON = `{"model":"${MODEL}","max_tokens":64,"stream":false,`;
const GOLDEN_PRESERVE_NO_MARKERS = `${HEAD_JSON}"messages":[{"role":"user","content":[{"type":"text","text":"u1"}]},{"role":"assistant","content":[{"type":"text","text":"a1","cache_control":{"type":"ephemeral"}}]},{"role":"user","content":[{"type":"text","text":"u2"}]}],${TOOLS_JSON},${SYSTEM_JSON},"_toolNameMap":{}}`;
const GOLDEN_PRESERVE_OFF = `${HEAD_JSON}"messages":[{"role":"user","content":[{"type":"text","text":"u1","cache_control":{"type":"ephemeral"}}]},{"role":"assistant","content":[{"type":"text","text":"a1","cache_control":{"type":"ephemeral"}}]},{"role":"user","content":[{"type":"text","text":"u2"}]}],${TOOLS_JSON},${SYSTEM_JSON},"_toolNameMap":{}}`;

describe("D: preserve on with no client markers is unchanged", () => {
  test("byte-identical to the pre-fix output", () => {
    assert.equal(JSON.stringify(translate(NO_MARKER_BODY)), GOLDEN_PRESERVE_NO_MARKERS);
  });
});

describe("E: preserve off is unchanged", () => {
  test("byte-identical to the pre-fix output with no client markers", () => {
    assert.equal(JSON.stringify(translate(NO_MARKER_BODY, "claude", false)), GOLDEN_PRESERVE_OFF);
  });

  test("client markers are stripped and the heuristic is applied", () => {
    const marked = structuredClone(NO_MARKER_BODY) as { messages: Rec[] };
    marked.messages[2].content = [{ type: "text", text: "u1", cache_control: { ...MARK } }];
    marked.messages[0].content = [
      { type: "text", text: "sys one", cache_control: { type: "ephemeral", ttl: "5m" } },
      { type: "text", text: "sys two" },
    ];
    assert.equal(JSON.stringify(translate(marked, "claude", false)), GOLDEN_PRESERVE_OFF);
  });
});

describe("F: auto mode honours an explicit marker from any client on a Claude target", () => {
  const marked = liveShapeBody();
  const unmarked = NO_MARKER_BODY;
  const decide = (over: Rec) =>
    shouldPreserveCacheControl({
      userAgent: "python-httpx/0.27",
      isCombo: false,
      targetProvider: "claude",
      targetFormat: "claude",
      settings: { alwaysPreserveClientCache: "auto" },
      ...over,
    } as never);

  test("marker on a content part preserves", () => {
    assert.equal(decide({ clientBody: marked }), true);
  });

  test("a marker on a native body.system block preserves", () => {
    const body = { messages: [], system: [{ type: "text", text: "s", cache_control: MARK }] };
    assert.equal(decide({ clientBody: body }), true);
  });

  test("no marker, or no body given, stays off", () => {
    assert.equal(decide({ clientBody: unmarked }), false);
    assert.equal(decide({}), false);
  });

  test('"never" still wins', () => {
    const settings = { alwaysPreserveClientCache: "never" };
    assert.equal(decide({ clientBody: marked, settings }), false);
  });

  test("non-claude target formats are unaffected", () => {
    for (const targetProvider of ["openai", "alibaba", "deepseek", "gemini"]) {
      assert.equal(
        decide({ clientBody: marked, targetProvider, targetFormat: "openai" }),
        false,
        targetProvider
      );
    }
  });

  test("Claude-shape providers outside the cache allowlist are unaffected", () => {
    for (const targetProvider of ["kimi-coding", "glm", "minimax", "zai"]) {
      assert.equal(decide({ clientBody: marked, targetProvider }), false, targetProvider);
    }
  });

  test("a connection that opted out of caching is unaffected", () => {
    for (const connectionCacheOverride of [
      { supportsPromptCaching: false },
      { cacheControlPassthrough: "strip" },
    ]) {
      assert.equal(decide({ clientBody: marked, connectionCacheOverride }), false);
    }
  });

  test("the body is only scanned when it can change the outcome", () => {
    const exploding = new Proxy(
      {},
      {
        get() {
          throw new Error("body must not be scanned");
        },
      }
    );
    const clientBody = exploding;
    assert.equal(decide({ clientBody, settings: { alwaysPreserveClientCache: "never" } }), false);
    assert.equal(decide({ clientBody, settings: { alwaysPreserveClientCache: "always" } }), true);
    assert.equal(decide({ clientBody, userAgent: "claude-cli/2.0" }), true);
    assert.equal(decide({ clientBody, targetProvider: "openai", targetFormat: "openai" }), false);
    assert.equal(decide({ clientBody, targetProvider: "glm" }), false);
  });
});

describe("G: other providers on the same translator", () => {
  for (const provider of ["anthropic", "vertex", "anthropic-compatible-acme"]) {
    test(`${provider} keeps client markers and adds none of its own`, () => {
      const out = translate(liveShapeBody(), provider);
      assert.deepEqual(markers(out), [["user:long stable document", MARK]]);
    });

    test(`${provider} with no client markers still gets the gateway ones`, () => {
      const out = translate(NO_MARKER_BODY, provider);
      assert.ok(markers(out).length > 0);
    });
  }

  for (const provider of ["kimi-coding", "glm", "minimax"]) {
    test(`${provider} gets no client marker, its output matches a marker-free request`, () => {
      const marked = liveShapeBody();
      const unmarked = liveShapeBody();
      ((unmarked.messages as Rec[])[1] as Rec).content = [
        { type: "text", text: "long stable document" },
      ];
      assert.equal(
        JSON.stringify(translate(marked, provider)),
        JSON.stringify(translate(unmarked, provider))
      );
      assert.ok(
        !markers(translate(marked, provider)).some(([where]) => where.startsWith("user:long")),
        "the client's marker never reaches a Claude-shape upstream outside the allowlist"
      );
    });
  }
});

describe("executor request transform (Claude OAuth cloak)", () => {
  async function runExecutor(body: Rec): Promise<Rec> {
    const executor = await getExecutor("claude");
    let upstream: Rec | null = null;
    globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
      upstream = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "msg_1", type: "message", content: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await executor.execute({
        model: MODEL,
        body,
        stream: false,
        credentials: { accessToken: "sk-ant-oat-test-cache-markers" },
        clientHeaders: { "x-omniroute-effort": "off" },
      } as never);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(upstream, "the executor must have called fetch");
    return upstream as Rec;
  }

  test("billing and sentinel blocks stay unmarked, the client marker stays, nothing is added", async () => {
    const translated = translate({
      model: MODEL,
      messages: [
        { role: "system", content: [{ type: "text", text: "sys", cache_control: { ...MARK } }] },
        ...(liveShapeBody().messages as Rec[]).slice(1),
      ],
      tools: [
        {
          type: "function",
          cache_control: { ...MARK },
          function: { name: "t", parameters: { type: "object", properties: {} } },
        },
      ],
    });
    const upstream = await runExecutor(translated);
    const system = upstream.system as Rec[];
    assert.match(String(system[0].text), /x-anthropic-billing-header/);
    assert.equal(system[0].cache_control, undefined);
    assert.equal(system[1].cache_control, undefined);

    // normalizeCacheControlTtl defaults a ttl-less marker to 1h on this path, /v1/messages too.
    const oneHour = { type: "ephemeral", ttl: "1h" };
    assert.deepEqual(markers(upstream), [
      ["system:sys", oneHour],
      ["user:long stable document", oneHour],
    ]);
  });

  test("an explicit ttl survives and a later ttl-less marker cannot jump above a 5m one", async () => {
    const translated = translate({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "u1", cache_control: { type: "ephemeral", ttl: "5m" } },
            { type: "text", text: "u2", cache_control: { ...MARK } },
          ],
        },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u3" },
      ],
    });
    const upstream = await runExecutor(translated);
    assert.deepEqual(markers(upstream), [
      ["user:u1", { type: "ephemeral", ttl: "5m" }],
      ["user:u2", { type: "ephemeral", ttl: "5m" }],
    ]);
  });
});

describe("handleChatCore end to end (the live route shape)", () => {
  async function callChat(body: Rec, mode: string, userAgent = "python-httpx/0.27"): Promise<Rec> {
    await settingsDb.updateSettings({ alwaysPreserveClientCache: mode });
    invalidateCacheControlSettingsCache();
    let upstream: Rec | null = null;
    globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
      upstream = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [{ type: "text", text: "yes" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;
    try {
      const noop = () => {};
      const result = await handleChatCore({
        body: structuredClone(body),
        modelInfo: { provider: "claude", model: MODEL, extendedContext: false },
        credentials: { apiKey: "claude-key", providerSpecificData: {} },
        log: { debug: noop, info: noop, warn: noop, error: noop },
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(body),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent,
      } as never);
      assert.equal((result as { success: boolean }).success, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(upstream, "handleChatCore must have called fetch");
    return upstream as Rec;
  }

  test('"always": both calls carry only the client marker on an identical prefix', async () => {
    const first = await callChat(liveShapeBody("middle step A"), "always");
    const second = await callChat(liveShapeBody("middle step B"), "always");
    assert.deepEqual(markers(first), [["user:long stable document", MARK]]);
    assert.deepEqual(markers(second), [["user:long stable document", MARK]]);
    assert.deepEqual(first.system, second.system);
    assert.deepEqual((first.messages as Rec[])[0], (second.messages as Rec[])[0]);
  });

  test('"auto" with a non Claude Code User-Agent and a client marker preserves', async () => {
    const upstream = await callChat(liveShapeBody(), "auto");
    assert.deepEqual(markers(upstream), [["user:long stable document", MARK]]);
  });

  test('"auto" with no client marker keeps the heuristic', async () => {
    const body = liveShapeBody();
    ((body.messages as Rec[])[1] as Rec).content = "long stable document";
    const upstream = await callChat(body, "auto");
    assert.ok(markers(upstream).length > 1, "the heuristic places its own markers");
    assert.ok(markers(upstream).some(([where]) => where === "assistant:Understood."));
  });

  test('"never" strips the client marker and applies the heuristic', async () => {
    const upstream = await callChat(liveShapeBody(), "never");
    const where = markers(upstream).map(([label]) => label);
    assert.ok(!where.includes("user:long stable document"));
    assert.ok(where.includes("assistant:Understood."));
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  invalidateCacheControlSettingsCache();
  core.resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
