/**
 * End-to-end test for the OmniRoute OAuth bridge browser extension
 * (packages/oauth-bridge-extension), loaded unpacked into a real Chromium.
 *
 * Self-contained: it does NOT need the OmniRoute app. A stub "dashboard" is served with
 * node:http on http://127.0.0.1:<random port>. Like the real dashboard it embeds the
 * extension's hidden `bridge.html` frame (under a CSP whose frame-src comes from
 * scripts/build/oauth-bridge-csp.mjs, the same directive next.config.mjs adds), opens
 * `approve.html?origin=<origin>` with window.open, and the operator's Allow click is a real
 * click. No chrome.permissions prompt is involved anywhere.
 *
 * Skipped unless OMNIROUTE_E2E_EXTENSION=1, because the repo playwright.config.ts boots the full
 * app as its webServer. Run it with a minimal config that has no webServer, for example:
 *
 *   // oauth-bridge.playwright.config.mjs (outside the repo: a plain object, no imports, so it
 *   // resolves without node_modules next to it)
 *   export default {
 *     testDir: "<repo>/tests/e2e",
 *     testMatch: /oauth-bridge-extension\.spec\.ts$/,
 *     workers: 1,
 *     timeout: 60000,
 *     outputDir: "<scratch dir>/test-results",
 *   };
 *
 *   OMNIROUTE_E2E_EXTENSION=1 npx playwright test --config /abs/path/oauth-bridge.playwright.config.mjs
 *
 * If Playwright reports a missing browser revision, either run `npx playwright install chromium`
 * or set OMNIROUTE_E2E_CHROMIUM_PATH to a Chrome for Testing binary.
 */
import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { oauthHelperFrameSrc } from "../../scripts/build/oauth-bridge-csp.mjs";

const EXTENSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/oauth-bridge-extension"
);
// The Codex OAuth redirect URI is fixed by the provider (not the dashboard origin), so it is
// assembled from parts rather than written as one absolute-origin literal.
const CODEX_CALLBACK_HOST = "localhost";
const CODEX_REDIRECT_URI = `http://${CODEX_CALLBACK_HOST}:1455/auth/callback`;

test.skip(
  process.env.OMNIROUTE_E2E_EXTENSION !== "1",
  "set OMNIROUTE_E2E_EXTENSION=1 (needs a config without the app webServer)"
);

test.describe.configure({ mode: "serial" });

let server: http.Server;
let port: number;
let dashboardOrigin: string;
let extensionId: string;
let userDataDir: string;
let context: BrowserContext;
let worker: Worker;
let callbackHits = 0;

/** The slice of the chrome.* API used from the service worker (no @types/chrome in the repo). */
interface ChromeLike {
  declarativeNetRequest: { getSessionRules(): Promise<unknown[]> };
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
}

type BridgeMessage = Record<string, unknown>;
type StubWindow = Window & { __bridge: BridgeMessage[]; __marker?: number };

function sessionRuleCount(): Promise<number> {
  return worker.evaluate(() =>
    (globalThis as unknown as { chrome: ChromeLike }).chrome.declarativeNetRequest
      .getSessionRules()
      .then((r) => r.length)
  );
}

// The stub dashboard page: records every message from the bridge frame in window.__bridge.
// /nested embeds a page of another origin that embeds the bridge (two levels deep).
const DASHBOARD_SCRIPT = `
  window.__bridge = [];
  const ext = new URLSearchParams(location.search).get("ext");
  const extOrigin = "chrome-extension://" + ext;
  window.addEventListener("message", (event) => {
    const frame = document.getElementById("bridge");
    if (event.origin !== extOrigin || !frame || event.source !== frame.contentWindow) return;
    window.__bridge.push(event.data);
  });
  const frame = document.createElement("iframe");
  frame.id = "bridge";
  frame.hidden = true;
  frame.src = extOrigin + "/bridge.html";
  document.body.appendChild(frame);
`;

function startStubDashboard(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "text/html; charset=utf-8");
    // A dashboard-like CSP: without the helper's frame-src the bridge frame is blocked.
    res.setHeader(
      "content-security-policy",
      `default-src 'self'; script-src 'self' 'unsafe-inline'; ${oauthHelperFrameSrc({
        NEXT_PUBLIC_OAUTH_HELPER_EXTENSION_ID: extensionId,
      })} http://localhost:*`
    );
    if (url.pathname === "/callback") {
      callbackHits += 1;
      res.end("<!doctype html><title>callback</title><p id='loc'></p>");
      return;
    }
    if (url.pathname === "/nested") {
      const inner = `http://localhost:${port}/?ext=${encodeURIComponent(url.searchParams.get("ext") ?? "")}`;
      res.end(`<!doctype html><title>nested</title><iframe id="inner" src="${inner}"></iframe>`);
      return;
    }
    res.end(
      `<!doctype html><title>stub dashboard</title><p>dashboard</p><script>${DASHBOARD_SCRIPT}</script>`
    );
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

function bridgeMessages(page: Page): Promise<BridgeMessage[]> {
  return page.evaluate(() => (window as unknown as StubWindow).__bridge.slice());
}

async function openDashboard(origin = dashboardOrigin): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin}/?ext=${extensionId}`);
  await expect
    .poll(async () => (await bridgeMessages(page)).find((m) => m.type === "ready"))
    .toBeTruthy();
  return page;
}

/** Posts an arm request to the bridge frame and resolves with its reply. */
async function arm(page: Page, state: string, requestId: string, redirectUri = CODEX_REDIRECT_URI) {
  return page.evaluate(
    ({ state, requestId, redirectUri, extensionId }) =>
      new Promise<BridgeMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no reply from extension")), 5000);
        const frame = document.getElementById("bridge") as HTMLIFrameElement;
        window.addEventListener("message", (event) => {
          const data = event.data;
          if (event.source !== frame.contentWindow) return;
          if (!data || data.source !== "omniroute-oauth-bridge") return;
          if (data.requestId !== requestId) return;
          clearTimeout(timer);
          resolve(data);
        });
        frame.contentWindow?.postMessage(
          {
            source: "omniroute-dashboard",
            type: "oauth-bridge:arm",
            requestId,
            provider: "codex",
            state,
            redirectUri,
          },
          `chrome-extension://${extensionId}`
        );
      }),
    { state, requestId, redirectUri, extensionId }
  );
}

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-obx-e2e-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    // Optional: point at an already-downloaded Chrome for Testing build when the cached
    // browser revision does not match the installed Playwright version.
    executablePath: process.env.OMNIROUTE_E2E_CHROMIUM_PATH || undefined,
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const match = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\/src\/background\.js$/);
  expect(match).toBeTruthy();
  extensionId = match![1];
  server = await startStubDashboard();
  port = (server.address() as AddressInfo).port;
  dashboardOrigin = `http://127.0.0.1:${port}`;
  // Let onInstalled (clearStaleRules) settle first.
  await new Promise((r) => setTimeout(r, 500));
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("an unapproved dashboard sees ready(approved: false) and cannot arm", async () => {
  const page = await openDashboard();
  const ready = (await bridgeMessages(page)).find((m) => m.type === "ready");
  expect(ready).toMatchObject({ source: "omniroute-oauth-bridge", approved: false });
  expect(String(ready?.version)).toMatch(/\d/);
  const reply = await arm(page, "s0", "req-0");
  expect(reply).toMatchObject({ type: "oauth-bridge:error", reason: "unapproved-origin" });
  expect(await sessionRuleCount()).toBe(0);
  await page.close();
});

test("a bridge frame nested two levels deep never announces itself", async () => {
  const page = await context.newPage();
  await page.goto(`${dashboardOrigin}/nested?ext=${extensionId}`);
  const inner = page.frameLocator("#inner");
  await expect(inner.locator("p")).toHaveText("dashboard");
  await page.waitForTimeout(1500);
  const innerFrame = page.frames().find((f) => f.url().startsWith(`http://localhost:${port}/`));
  expect(innerFrame).toBeTruthy();
  // The bridge frame did load inside the inner page; it just stays silent.
  const bridgeFrame = page.frames().find((f) => f.url().endsWith("/bridge.html"));
  expect(bridgeFrame?.parentFrame()).toBe(innerFrame);
  const seen = await innerFrame!.evaluate(() => (window as unknown as StubWindow).__bridge.length);
  expect(seen).toBe(0);
  await page.close();
});

test("Allow approves the dashboard: the approve window closes itself and the page gets approved without a reload", async () => {
  const page = await openDashboard();
  await page.evaluate(() => {
    (window as unknown as StubWindow).__marker = 42;
  });
  const approveUrl = `chrome-extension://${extensionId}/approve.html?origin=${encodeURIComponent(dashboardOrigin)}`;
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.evaluate(
      (url) => void window.open(url, "omniroute-helper-approve", "popup,width=420,height=560"),
      approveUrl
    ),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  const allow = popup.getByRole("button", { name: /^Allow on 127\.0\.0\.1:\d+$/ });
  await expect(allow).toBeVisible();
  await expect(allow).toBeEnabled();
  const closed = popup.waitForEvent("close", { timeout: 5000 });
  await allow.click();
  await expect(popup.locator("#status")).toContainText("Allowed");
  await closed;

  await expect
    .poll(async () => (await bridgeMessages(page)).some((m) => m.type === "approved"))
    .toBe(true);
  expect(await page.evaluate(() => (window as unknown as StubWindow).__marker)).toBe(42);
  const stored = await worker.evaluate(() =>
    (globalThis as unknown as { chrome: ChromeLike }).chrome.storage.local.get("approvedOrigins")
  );
  expect(stored.approvedOrigins).toEqual([dashboardOrigin]);

  // A freshly loaded dashboard page now starts approved.
  const fresh = await openDashboard();
  expect((await bridgeMessages(fresh)).find((m) => m.type === "ready")).toMatchObject({
    approved: true,
  });
  await fresh.close();
  await page.close();
});

test("armed sign-in redirects the loopback callback to the dashboard and closes the tab", async () => {
  const page = await openDashboard();
  const reply = await arm(page, "s", "req-1");
  expect(reply).toMatchObject({ type: "oauth-bridge:armed", requestId: "req-1" });

  expect(await sessionRuleCount()).toBe(1);

  // Nothing listens on :1455; the DNR redirect fires before the request goes out.
  await page.goto(`${CODEX_REDIRECT_URI}?code=c&state=s`);
  await page.waitForURL(`${dashboardOrigin}/callback?code=c&state=s`);
  expect(page.url()).toBe(`${dashboardOrigin}/callback?code=c&state=s`);
  expect(callbackHits).toBe(1);

  // Background closes the tab ~3s after the /callback commit.
  await page.waitForEvent("close", { timeout: 6000 });

  // The rule is single use: it was removed on commit.
  await expect.poll(() => sessionRuleCount()).toBe(0);
});

test("a callback with a different state is not redirected", async () => {
  const page = await openDashboard();
  const reply = await arm(page, "s2", "req-2");
  expect(reply).toMatchObject({ type: "oauth-bridge:armed", requestId: "req-2" });

  const hitsBefore = callbackHits;
  const target = `${CODEX_REDIRECT_URI}?code=c&state=other`;
  const error = await page.goto(target).then(
    () => null,
    (e: Error) => e
  );
  expect(error?.message ?? "").toMatch(/ERR_CONNECTION_REFUSED/);
  // A failed navigation leaves page.url() on the previous (dashboard) page; what matters is
  // that the dashboard /callback was never requested and the armed rule is still in place.
  expect(page.url()).not.toContain("/callback");
  expect(callbackHits).toBe(hitsBefore);
  expect(await sessionRuleCount()).toBe(1);
  await page.close();
});

test("a redirect URI outside the safety policy is rejected", async () => {
  const page = await openDashboard();
  const reply = await arm(page, "s3", "req-3", "https://evil.example/callback");
  expect(reply).toMatchObject({ type: "oauth-bridge:error", reason: "redirect-not-allowed" });
  await page.close();
});

test("another origin is still unapproved after the first one was allowed", async () => {
  const page = await openDashboard(`http://localhost:${port}`);
  expect((await bridgeMessages(page)).find((m) => m.type === "ready")).toMatchObject({
    approved: false,
  });
  const reply = await arm(page, "s4", "req-4");
  expect(reply).toMatchObject({ type: "oauth-bridge:error", reason: "unapproved-origin" });
  await page.close();
});
