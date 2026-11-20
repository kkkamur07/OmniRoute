// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RETURN_CLOSE_GRACE_MS,
  returnToDashboard,
} from "@/shared/components/oauthModal/returnToDashboard";

function fakeWindow(closes: boolean) {
  const win = {
    closed: false,
    close: vi.fn(() => {
      if (closes) win.closed = true;
    }),
    location: { assign: vi.fn() },
  };
  return win;
}

describe("returnToDashboard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("closes the tab and does not navigate when the close succeeds", () => {
    const win = fakeWindow(true);
    returnToDashboard(win);
    expect(win.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(RETURN_CLOSE_GRACE_MS);
    expect(win.location.assign).not.toHaveBeenCalled();
  });

  it("navigates to /dashboard when the browser refuses to close the tab", () => {
    const win = fakeWindow(false);
    returnToDashboard(win);
    expect(win.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(RETURN_CLOSE_GRACE_MS - 1);
    expect(win.location.assign).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.location.assign).toHaveBeenCalledWith("/dashboard");
  });

  it("still navigates when close throws", () => {
    const win = fakeWindow(false);
    win.close.mockImplementation(() => {
      throw new Error("blocked");
    });
    returnToDashboard(win);
    vi.advanceTimersByTime(RETURN_CLOSE_GRACE_MS);
    expect(win.location.assign).toHaveBeenCalledWith("/dashboard");
  });
});
