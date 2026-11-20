/**
 * End-to-end test for the OmniRoute OAuth bridge browser extension
 * (packages/oauth-bridge-extension), loaded unpacked into a real Chromium.
 *
 * Self-contained: it does NOT need the OmniRoute app. A stub "dashboard" is served with
 * node:http on http://127.0.0.1:<random port> (covered by the extension's required
 * host_permissions), the origin is approved by writing chrome.storage.local and registering the
 * content script from the service worker (what the popup does after a user gesture), and the
 * page then runs the real postMessage arm handshake.
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

const EXTENSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/oauth-bridge-extension"
);
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CONTENT_SCRIPT_ID = "omniroute-oauth-bridge";

test.skip(
  process.env.OMNIROUTE_E2E_EXTENSION !== "1",
  "set OMNIROUTE_E2E_EXTENSION=1 (needs a config without the app webServer)"
);

test.describe.configure({ mode: "serial" });

let server: http.Server;
let dashboardOrigin: string;
let userDataDir: string;
let context: BrowserContext;
let worker: Worker;
let callbackHits = 0;

/** The slice of the chrome.* API used from the service worker (no @types/chrome in the repo). */
interface ChromeLike {
  storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
  permissions: { contains(p: { origins: string[] }): Promise<boolean> };
  scripting: {
    getRegisteredContentScripts(filter: { ids: string[] }): Promise<unknown[]>;
    registerContentScripts(scripts: unknown[]): Promise<void>;
    updateContentScripts(scripts: unknown[]): Promise<void>;
  };
  declarativeNetRequest: { getSessionRules(): Promise<unknown[]> };
}

function sessionRuleCount(): Promise<number> {
  return worker.evaluate(() =>
    (globalThis as unknown as { chrome: ChromeLike }).chrome.declarativeNetRequest
      .getSessionRules()
      .then((r) => r.length)
  );
}

function startStubDashboard(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/callback") {
      callbackHits += 1;
      res.end("<!doctype html><title>callback</title><p id='loc'></p>");
      return;
    }
    res.end("<!doctype html><title>stub dashboard</title><p>dashboard</p>");
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

/** Posts an arm request from the page and resolves with the extension's reply. */
async function arm(page: Page, state: string, requestId: string) {
  return page.evaluate(
    ({ state, requestId, redirectUri }) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no reply from extension")), 5000);
        window.addEventListener("message", (event) => {
          const data = event.data;
          if (!data || data.source !== "omniroute-oauth-bridge") return;
          if (data.requestId !== requestId) return;
          clearTimeout(timer);
          resolve(data);
        });
        window.postMessage(
          {
            source: "omniroute-dashboard",
            type: "oauth-bridge:arm",
            requestId,
            provider: "codex",
            state,
            redirectUri,
          },
          location.origin
        );
      }),
    { state, requestId, redirectUri: CODEX_REDIRECT_URI }
  );
}

async function openDashboard(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${dashboardOrigin}/`);
  // content.js stamps the version on <html> once injected.
  await expect(page.locator("html")).toHaveAttribute("data-omniroute-oauth-bridge", /\d/);
  return page;
}

test.beforeAll(async () => {
  server = await startStubDashboard();
  dashboardOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  expect(worker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/src\/background\.js$/);

  // Let onInstalled (clearStaleRules + syncContentScripts with no origins) settle first, so it
  // cannot unregister the script registered below.
  await new Promise((r) => setTimeout(r, 1000));

  await worker.evaluate(
    async ({ origin, id }) => {
      const c = (globalThis as unknown as { chrome: ChromeLike }).chrome;
      await c.storage.local.set({ approvedOrigins: [origin] });
      const granted = await c.permissions.contains({ origins: [`${origin}/*`] });
      if (!granted) throw new Error(`host permission not granted for ${origin}`);
      const script = {
        id,
        matches: [`${origin}/*`],
        js: ["src/content.js"],
        runAt: "document_start" as const,
        persistAcrossSessions: true,
      };
      const existing = await c.scripting.getRegisteredContentScripts({ ids: [id] });
      if (existing.length > 0) await c.scripting.updateContentScripts([script]);
      else await c.scripting.registerContentScripts([script]);
    },
    { origin: dashboardOrigin, id: CONTENT_SCRIPT_ID }
  );
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
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

test("a redirect URI not allow-listed for the provider is rejected", async () => {
  const page = await openDashboard();
  const reply = await page.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        window.addEventListener("message", (event) => {
          if (event.data?.source === "omniroute-oauth-bridge" && event.data.requestId === "req-3") {
            resolve(event.data);
          }
        });
        window.postMessage(
          {
            source: "omniroute-dashboard",
            type: "oauth-bridge:arm",
            requestId: "req-3",
            provider: "codex",
            state: "s3",
            redirectUri: "http://localhost:9999/evil",
          },
          location.origin
        );
      })
  );
  expect(reply).toMatchObject({ type: "oauth-bridge:error", reason: "redirect-not-allowed" });
  await page.close();
});
