import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

// requestRetry = 0 means "stop at the first 429": the rate limit goes straight back to
// the client. No intra-URL resend, no rotation to a sibling account, no emergency hop
// to another model. A fake upstream counts every request that leaves the gateway.

const harness = await createChatPipelineHarness("chat-stop-at-first-429");
const { BaseExecutor, buildRequest, handleChat, resetStorage, seedConnection, settingsDb } =
  harness;
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");
const { resetEmergencyFallbackEnvCache } =
  await import("../../open-sse/services/emergencyFallback.ts");

const originalRetryDelay = BaseExecutor.RETRY_CONFIG.delayMs;
const originalEmergencyEnv = process.env.OMNIROUTE_EMERGENCY_FALLBACK;

type Hit = { url: string; auth: string | null };

function installCountingUpstream(message: string): Hit[] {
  const hits: Hit[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    hits.push({ url, auth: headers.get("authorization") });
    // No Retry-After and no body hint: exactly the 429 the intra-URL retry used to resend.
    return new Response(JSON.stringify({ error: { message } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  };
  return hits;
}

async function sendChat(content: string) {
  return handleChat(
    buildRequest({
      body: {
        model: "openai/gpt-4.1",
        stream: false,
        messages: [{ role: "user", content }],
      },
    })
  );
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  delete process.env.OMNIROUTE_EMERGENCY_FALLBACK;
  resetEmergencyFallbackEnvCache();
  await rateLimitManager.__resetRateLimitManagerForTests();
  await resetStorage();
});

test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = originalRetryDelay;
  if (originalEmergencyEnv === undefined) delete process.env.OMNIROUTE_EMERGENCY_FALLBACK;
  else process.env.OMNIROUTE_EMERGENCY_FALLBACK = originalEmergencyEnv;
  resetEmergencyFallbackEnvCache();
  await rateLimitManager.__resetRateLimitManagerForTests();
  await resetStorage();
});

test.after(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
  await harness.cleanup();
});

test("requestRetry=0: one upstream 429 gives exactly one upstream request", async () => {
  await seedConnection("openai", { apiKey: "sk-first-account", name: "first" });
  await seedConnection("openai", { apiKey: "sk-second-account", name: "second" });
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  const hits = installCountingUpstream("Rate limit reached for requests");

  const response = await sendChat("one 429, one request");

  assert.equal(response.status, 429);
  assert.equal(hits.length, 1, `expected one upstream request, got ${hits.length}`);
});

test("requestRetry=0: a quota-worded 429 does not hop to the emergency fallback model", async () => {
  await seedConnection("openai", { apiKey: "sk-only-account" });
  await seedConnection("nvidia", { apiKey: "nvapi-fallback" });
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  const hits = installCountingUpstream("You exceeded your current quota (quota exceeded)");

  const response = await sendChat("no emergency hop");

  assert.equal(response.status, 429);
  assert.equal(hits.length, 1, `expected one upstream request, got ${hits.length}`);
  assert.equal(response.headers.get("x-omniroute-emergency-fallback"), null);
});

test("requestRetry>0 keeps today's 429 retry and account rotation", async () => {
  await seedConnection("openai", { apiKey: "sk-first-account", name: "first" });
  await seedConnection("openai", { apiKey: "sk-second-account", name: "second" });
  await settingsDb.updateSettings({ requestRetry: 3, maxRetryIntervalSec: 0 });
  const hits = installCountingUpstream("Rate limit reached for requests");

  const response = await sendChat("default path unchanged");

  assert.equal(response.status, 429);
  assert.ok(hits.length > 1, `expected the default path to resend, got ${hits.length}`);
  assert.equal(new Set(hits.map((hit) => hit.auth)).size, 2, "expected rotation to account two");
});
