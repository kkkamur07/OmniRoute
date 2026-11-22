"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  HELPER_POLL_INTERVAL_MS,
  OAUTH_HELPER_STORE_URL,
  closeIfBlank,
  helperSetupView,
  openApproveWindow,
  probeHelper,
  readHelperDismissed,
  writeHelperDismissed,
  type HelperProbe,
  type HelperSetupView,
  type PreopenedWindow,
} from "./helperExtension";
import { isTrueLocalhostHost, shouldShowBridgeHint } from "./useOAuthBridge";

export type UseHelperSetupOptions = {
  provider: string | undefined;
  /** Defaults to the page's own host (the helper is offered on remote dashboards only). */
  isTrueLocalhost?: boolean;
  bridgeVersion: string | null;
  /** The setup step may show (probing and polling stop when false; `gate` ignores it). */
  active: boolean;
  /** Resumes the sign-in once the helper is ready; omit when the dialog re-arms by itself. */
  onContinue?: () => void;
  /**
   * Window name the flow opens the provider page in. When set, the hook pre-opens it on ready so
   * the flow can continue without a click; when that is blocked a Continue button is shown.
   */
  popupName?: string;
  /**
   * The sign-in stopped before the provider page loaded (error step, dialog closed). A window
   * pre-opened for `popupName` that is still blank is then closed.
   */
  abandoned?: boolean;
};

export type HelperSetup = {
  probe: HelperProbe | null;
  view: HelperSetupView;
  /** Probes once and says whether the dialog should show the setup step before signing in. */
  gate: () => Promise<boolean>;
  install: () => void;
  allow: () => void;
  /** Paste the link instead; `always` remembers the choice in localStorage. */
  skip: (always?: boolean) => void;
  continueNow: () => void;
  /** Ready, but the provider window could not open without a click. */
  awaitingContinue: boolean;
};

/** Shared state for the Sign-in Helper setup step (OAuthModal, ChatGPT, M365 dialogs). */
export function useHelperSetup(opts: UseHelperSetupOptions): HelperSetup {
  const { provider, bridgeVersion, active, popupName, abandoned } = opts;
  const isTrueLocalhost =
    opts.isTrueLocalhost ?? isTrueLocalhostHost(globalThis.location?.hostname);
  const eligibleProvider = shouldShowBridgeHint({ provider, isTrueLocalhost, bridgeVersion: null });
  const eligible = active && eligibleProvider;
  const [probe, setProbe] = useState<HelperProbe | null>(null);
  // The stored "always paste" choice; the view stays "none" until a probe, so SSR matches.
  const [dismissed, setDismissed] = useState(() => readHelperDismissed());
  const [awaitingContinue, setAwaitingContinue] = useState(false);
  const setupShownRef = useRef(false);
  const preopenedRef = useRef<PreopenedWindow | null>(null);
  const continueRef = useRef(opts.onContinue);
  useEffect(() => {
    continueRef.current = opts.onContinue;
  });

  // A closed dialog forgets this attempt's choices (the stored "always paste" one stays).
  // Render-time adjustment (react.dev "You Might Not Need an Effect").
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (!active) {
      setProbe(null);
      setDismissed(readHelperDismissed());
      setAwaitingContinue(false);
    }
  }

  const effectiveProbe: HelperProbe | null = bridgeVersion ? "ready" : probe;
  const view = helperSetupView({
    eligible,
    probe: effectiveProbe,
    dismissed,
    awaitingContinue,
  });
  useEffect(() => {
    if (!active) setupShownRef.current = false;
    else if (view === "absent" || view === "installed") setupShownRef.current = true;
  }, [view, active]);

  // First probe for dialogs that render the step from `view` (ChatGPT, M365).
  useEffect(() => {
    if (!eligible || dismissed || probe !== null) return undefined;
    let live = true;
    void probeHelper().then((result) => {
      if (live) setProbe(result);
    });
    return () => {
      live = false;
    };
  }, [eligible, dismissed, probe]);

  // Poll while the setup step is up so it advances by itself (absent -> installed -> ready).
  const polling = view === "absent" || view === "installed";
  useEffect(() => {
    if (!polling) return undefined;
    let live = true;
    const timer = setInterval(() => {
      void probeHelper().then((result) => {
        if (live) setProbe(result);
      });
    }, HELPER_POLL_INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [polling]);

  // Ready after the step was shown: continue the sign-in on its own when the browser lets the
  // provider window open, else keep the step up with a Continue button.
  useEffect(() => {
    if (!bridgeVersion || !setupShownRef.current || dismissed) return;
    setupShownRef.current = false;
    const resume = continueRef.current;
    if (!resume) return;
    let opened: unknown = null;
    if (popupName) {
      try {
        opened = window.open("about:blank", popupName);
      } catch {
        opened = null;
      }
    }
    if (opened) {
      preopenedRef.current = opened as PreopenedWindow;
      resume();
    } else setAwaitingContinue(true);
  }, [bridgeVersion, dismissed, popupName]);

  // A failed or cancelled continuation must not leave an empty tab behind.
  useEffect(() => {
    if (!abandoned || !preopenedRef.current) return;
    closeIfBlank(preopenedRef.current);
    preopenedRef.current = null;
  }, [abandoned]);
  useEffect(() => () => void closeIfBlank(preopenedRef.current), []);

  const gate = useCallback(async () => {
    if (!eligibleProvider || readHelperDismissed()) return false;
    const result = await probeHelper();
    setProbe(result);
    return result === "absent" || result === "installed";
  }, [eligibleProvider]);

  const install = useCallback(() => {
    window.open(OAUTH_HELPER_STORE_URL, "_blank", "noopener,noreferrer");
  }, []);

  const allow = useCallback(() => {
    openApproveWindow(window.location.origin);
  }, []);

  const skip = useCallback((always?: boolean) => {
    if (always) writeHelperDismissed();
    setDismissed(true);
    setAwaitingContinue(false);
    setupShownRef.current = false;
  }, []);

  const continueNow = useCallback(() => {
    setAwaitingContinue(false);
    continueRef.current?.();
  }, []);

  return { probe: effectiveProbe, view, gate, install, allow, skip, continueNow, awaitingContinue };
}
