// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  SIGN_IN_ATTEMPT_MAX_AGE_MS,
  SIGN_IN_ATTEMPT_PREFIX,
  rememberSignInAttempt,
  takeSignInAttempt,
} from "@/shared/components/oauthModal/signInAttempt";

const NOW = 1_700_000_000_000;

describe("sign-in attempt handoff", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("remembers then takes the attempt", () => {
    rememberSignInAttempt("s1", "openai", "OpenAI Codex", NOW);
    expect(takeSignInAttempt("s1", NOW + 1000)).toEqual({
      provider: "openai",
      providerName: "OpenAI Codex",
    });
  });

  it("take removes the entry", () => {
    rememberSignInAttempt("s1", "openai", "OpenAI Codex", NOW);
    takeSignInAttempt("s1", NOW);
    expect(window.localStorage.getItem(SIGN_IN_ATTEMPT_PREFIX + "s1")).toBeNull();
    expect(takeSignInAttempt("s1", NOW)).toBeNull();
  });

  it("returns null for a stale attempt", () => {
    rememberSignInAttempt("s1", "openai", "OpenAI Codex", NOW);
    expect(takeSignInAttempt("s1", NOW + SIGN_IN_ATTEMPT_MAX_AGE_MS + 1)).toBeNull();
  });

  it("is a no-op without state or provider", () => {
    rememberSignInAttempt("", "openai", "OpenAI", NOW);
    rememberSignInAttempt(undefined, "openai", "OpenAI", NOW);
    rememberSignInAttempt("s1", undefined, "OpenAI", NOW);
    expect(window.localStorage.length).toBe(0);
    expect(takeSignInAttempt(null, NOW)).toBeNull();
    expect(takeSignInAttempt(undefined, NOW)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    window.localStorage.setItem(SIGN_IN_ATTEMPT_PREFIX + "bad", "{not json");
    expect(takeSignInAttempt("bad", NOW)).toBeNull();
  });

  it("falls back to the provider id when no display name is given", () => {
    rememberSignInAttempt("s1", "openai", undefined, NOW);
    expect(takeSignInAttempt("s1", NOW)).toEqual({ provider: "openai", providerName: "openai" });
  });

  it("remember prunes expired entries of other states", () => {
    rememberSignInAttempt("old", "openai", "OpenAI", NOW);
    window.localStorage.setItem("unrelated", "keep");
    rememberSignInAttempt("new", "claude", "Claude", NOW + SIGN_IN_ATTEMPT_MAX_AGE_MS + 1);
    expect(window.localStorage.getItem(SIGN_IN_ATTEMPT_PREFIX + "old")).toBeNull();
    expect(window.localStorage.getItem(SIGN_IN_ATTEMPT_PREFIX + "new")).not.toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
  });
});
