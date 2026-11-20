// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/i18n/messages/en.json";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    const raw =
      (messages as unknown as Record<string, Record<string, string>>)[namespace]?.[key] ?? key;
    return raw.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? `{${name}}`));
  },
}));

import CallbackPage from "@/app/callback/page";
import { rememberSignInAttempt } from "@/shared/components/oauthModal/signInAttempt";

async function renderAt(url: string) {
  window.history.replaceState({}, "", url);
  await act(async () => {
    render(<CallbackPage />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("OAuth callback page status screens", () => {
  let originalOpener: typeof window.opener;

  beforeEach(() => {
    localStorage.clear();
    originalOpener = window.opener;
    Object.defineProperty(window, "opener", { configurable: true, writable: true, value: null });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "opener", {
      configurable: true,
      writable: true,
      value: originalOpener,
    });
  });

  it("names the provider from the dialog's handoff and shows the signed-in screen", async () => {
    rememberSignInAttempt("state-1", "codex", "OpenAI Codex");
    await renderAt("/callback?code=c&state=state-1");
    expect(screen.getByRole("status")).toHaveTextContent("You're signed in");
    expect(screen.getByText("You can close this tab.")).toBeInTheDocument();
    expect(screen.getByText("This tab closes in 3 s.")).toBeInTheDocument();
    expect(document.querySelector('img[src="/providers/codex.svg"]')).not.toBeNull();
    // The handoff entry is consumed; the relay still went out for the waiting dialog.
    expect(localStorage.getItem("omniroute_sign_in_attempt:state-1")).toBeNull();
    expect(JSON.parse(localStorage.getItem("oauth_callback") || "{}").code).toBe("c");
  });

  it("keeps the manual copy-URL screen when no dialog handed off this state", async () => {
    await renderAt("/callback?code=c&state=unknown");
    expect(screen.getByText(messages.auth.copyUrl)).toBeInTheDocument();
  });

  it("shows the provider error and a way back to OmniRoute", async () => {
    rememberSignInAttempt("state-2", "codex", "OpenAI Codex");
    await renderAt(
      "/callback?error=access_denied&error_description=User%20cancelled&state=state-2"
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in failed");
    expect(screen.getByText("User cancelled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to OmniRoute" })).toBeInTheDocument();
  });

  it("Back to OmniRoute tries to close the tab before navigating", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    await renderAt("/callback?error=access_denied&state=state-3");
    fireEvent.click(screen.getByRole("button", { name: "Back to OmniRoute" }));
    expect(close).toHaveBeenCalled();
    close.mockRestore();
  });
});
