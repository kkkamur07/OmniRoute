// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "@/i18n/messages/en.json";
import ProviderSignInStatus from "@/shared/components/oauthModal/ProviderSignInStatus";

const oauthMessages = (messages as unknown as Record<string, Record<string, string>>).oauthModal;

// Falls back to the key when en.json does not (yet) define it.
function translate(key: string, values?: Record<string, unknown>): string {
  const template = oauthMessages?.[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    values && name in values ? String(values[name]) : match
  );
}

vi.mock("next-intl", () => ({
  useTranslations: () => translate,
}));

const has = (key: string) => typeof oauthMessages?.[key] === "string";

afterEach(() => cleanup());

describe("ProviderSignInStatus", () => {
  for (const state of ["waiting", "success", "error"] as const) {
    describe(`state ${state}`, () => {
      it("renders the provider logo when providerId is given", () => {
        const { container } = render(
          <ProviderSignInStatus state={state} providerId="openai" providerName="OpenAI Codex" />
        );
        expect(
          container.querySelector("[data-sign-in-state]")?.getAttribute("data-sign-in-state")
        ).toBe(state);
        const img = container.querySelector('img[src="/providers/openai.svg"]');
        expect(img).not.toBeNull();
      });

      it("renders the generic key icon without a logo and falls back to the neutral name", () => {
        const { container } = render(<ProviderSignInStatus state={state} />);
        expect(
          container.querySelector("[data-sign-in-state]")?.getAttribute("data-sign-in-state")
        ).toBe(state);
        expect(container.querySelector('img[src^="/providers/"]')).toBeNull();
        const fallback = translate("statusProviderFallbackName");
        const bubble = container.querySelector(`[title="${fallback}"]`);
        expect(bubble).not.toBeNull();
        expect(bubble?.querySelector("img")).toBeNull();
        expect(bubble?.querySelector("svg, span")).not.toBeNull();
      });
    });
  }

  it("success renders a status region with the connected title and account line", () => {
    render(
      <ProviderSignInStatus
        state="success"
        providerId="openai"
        providerName="OpenAI Codex"
        account="a@b.c"
      />
    );
    const region = screen.getByRole("status");
    const heading = region.querySelector("h3");
    expect(heading?.textContent).toBe(
      translate("statusConnectedTitle", { providerName: "OpenAI Codex", name: "OpenAI Codex" })
    );
    if (has("statusConnectedTitle"))
      expect(region.textContent).toContain("Connected to OpenAI Codex");
    expect(region.textContent).toContain(translate("statusSignedInAs", { account: "a@b.c" }));
    if (has("statusSignedInAs")) expect(region.textContent).toContain("Signed in as a@b.c");
  });

  it("success without an account renders no account line", () => {
    render(<ProviderSignInStatus state="success" providerName="OpenAI Codex" />);
    const region = screen.getByRole("status");
    expect(region.querySelector("p")).toBeNull();
    expect(region.textContent).not.toContain("Signed in as");
  });

  it("error renders an alert and the description text", () => {
    render(
      <ProviderSignInStatus
        state="error"
        providerName="OpenAI Codex"
        description="State mismatch"
      />
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("State mismatch")).toBeTruthy();
  });

  it("waiting renders the waiting title with the provider name", () => {
    render(<ProviderSignInStatus state="waiting" providerName="OpenAI Codex" />);
    const region = screen.getByRole("status");
    expect(region.querySelector("h3")?.textContent).toBe(
      translate("statusWaitingTitle", { providerName: "OpenAI Codex", name: "OpenAI Codex" })
    );
    if (has("statusWaitingTitle")) expect(region.textContent).toContain("OpenAI Codex");
  });

  it("uses the fallback provider name in the waiting title when providerName is omitted", () => {
    render(<ProviderSignInStatus state="waiting" />);
    const fallback = translate("statusProviderFallbackName");
    if (has("statusProviderFallbackName") && has("statusWaitingTitle")) {
      expect(screen.getByRole("status").textContent).toContain(fallback);
    }
    expect(document.querySelector(`[title="${fallback}"]`)).not.toBeNull();
  });

  it("title prop overrides the default title", () => {
    render(<ProviderSignInStatus state="success" providerName="X" title="Custom title" />);
    expect(screen.getByRole("heading", { name: "Custom title" })).toBeTruthy();
  });

  it("headingLevel h1 renders an h1, default is h3", () => {
    const { rerender } = render(
      <ProviderSignInStatus state="success" providerName="X" headingLevel="h1" />
    );
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    rerender(<ProviderSignInStatus state="success" providerName="X" />);
    expect(screen.getByRole("heading", { level: 3 })).toBeTruthy();
  });

  it("renders children", () => {
    render(
      <ProviderSignInStatus state="success" providerName="X">
        <button type="button">Done</button>
      </ProviderSignInStatus>
    );
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });
});
