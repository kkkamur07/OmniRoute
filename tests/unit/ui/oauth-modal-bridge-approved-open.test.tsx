// @vitest-environment jsdom
// Regression: with the helper installed and this dashboard already approved, opening the Connect
// dialog must arm the helper. The bridge frame only mounts while the dialog is open, so it is
// still "loading" on the first render; the auto-start awaited the probe (frame now "ready") and
// then ran the startOAuthFlow closure from that first render, which still saw no helper. The
// sign-in went out unarmed and the provider redirect hit a dead localhost page.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => Object.assign((key: string) => key, { rich: (key: string) => key }),
}));

type Snapshot = { status: string; version: string | null };

const fake = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state: { snapshot: Snapshot } = { snapshot: { status: "idle", version: null } };
  const set = (next: Snapshot) => {
    state.snapshot = next;
    for (const listener of listeners) listener();
  };
  const frame = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state.snapshot,
    acquire: () => {
      set({ status: "loading", version: null });
      return () => set({ status: "idle", version: null });
    },
    reload: () => {},
    whenSettled: async () => state.snapshot,
    arm: vi.fn(async () => true),
  };
  return { frame, set, state, listeners };
});

vi.mock("@/shared/components/oauthModal/helperExtension", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/components/oauthModal/helperExtension")>();
  return {
    ...actual,
    getBridgeFrame: () => fake.frame,
    // Like the real probe: the frame answers "ready" (approved) and subscribers hear it before
    // the probe resolves.
    probeHelper: async () => {
      fake.set({ status: "ready", version: "1" });
      return "ready";
    },
  };
});

const { default: OAuthModal } = await import("@/shared/components/OAuthModal");

const roots: Array<{ root: ReturnType<typeof createRoot>; element: HTMLDivElement }> = [];

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

describe("OAuthModal with an already approved Sign-in Helper", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    // A remote dashboard: on true localhost the dialog never probes for the helper.
    (
      globalThis as typeof globalThis & { jsdom: { reconfigure(o: { url: string }): void } }
    ).jsdom.reconfigure({
      url: "https://dash.example.com/dashboard/providers",
    });
    fake.state.snapshot = { status: "idle", version: null };
    fake.frame.arm.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/authorize")) {
          return new Response(
            JSON.stringify({
              authUrl: "https://auth.openai.com/oauth/authorize?state=st-1",
              state: "st-1",
              codeVerifier: "verifier",
              redirectUri: "http://localhost:1455/auth/callback",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
      })
    );
    vi.stubGlobal(
      "open",
      vi.fn(() => ({ closed: false, close: vi.fn() }))
    );
  });

  afterEach(() => {
    for (const { root, element } of roots.splice(0)) {
      act(() => root.unmount());
      element.remove();
    }
    vi.unstubAllGlobals();
  });

  it("arms the helper on open instead of starting an unarmed sign-in", async () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    roots.push({ root, element });

    act(() => {
      root.render(
        <OAuthModal
          isOpen
          provider="codex"
          providerInfo={{ name: "Codex" }}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      );
    });
    await flush();

    expect(fake.frame.arm).toHaveBeenCalledTimes(1);
    expect(fake.frame.arm).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        state: "st-1",
        redirectUri: "http://localhost:1455/auth/callback",
      })
    );
  });
});
