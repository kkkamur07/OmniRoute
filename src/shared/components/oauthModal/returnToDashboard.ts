/** How long a refused `window.close()` gets before the tab navigates instead. */
export const RETURN_CLOSE_GRACE_MS = 300;

type ClosableWindow = Pick<Window, "close" | "closed"> & {
  location: Pick<Location, "assign">;
};

/**
 * "Back to OmniRoute" on the /callback tab: the dashboard tab that started the sign-in is
 * usually still open, so close this one first. Browsers only let a script-opened tab close
 * itself; when it is still open after a short grace period, navigate to the dashboard.
 */
export function returnToDashboard(
  win: ClosableWindow = window,
  path = "/dashboard",
  graceMs = RETURN_CLOSE_GRACE_MS
): void {
  try {
    win.close();
  } catch {
    // Treated like a refused close: the timer below navigates.
  }
  setTimeout(() => {
    if (!win.closed) win.location.assign(path);
  }, graceMs);
}
