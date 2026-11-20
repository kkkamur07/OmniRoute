"use client";

import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Icon from "@/shared/components/Icon";
import { Spinner } from "@/shared/components/Loading";
import ProviderSignInStatus from "@/shared/components/oauthModal/ProviderSignInStatus";
import {
  takeSignInAttempt,
  type SignInAttempt,
} from "@/shared/components/oauthModal/signInAttempt";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

/**
 * OAuth Callback Page
 *
 * Reads URL params via window.location.search (not useSearchParams) to avoid
 * the Next.js Suspense boundary requirement, which can delay hydration in popup
 * windows that navigate back from a cross-origin OAuth page (e.g. Google).
 * Sends the callback data back via three methods in order of reliability:
 *   1. postMessage to window.opener (may be null after COOP cross-origin nav)
 *   2. BroadcastChannel (same-origin, works across browsing context groups)
 *   3. localStorage storage event (works across browsing context groups)
 *
 * The provider is named from the same-origin attempt handoff the Connect dialog stored under
 * this `state` (oauthModal/signInAttempt.ts); without it the page shows a generic label.
 */

type CallbackStatus = "processing" | "success" | "done" | "manual" | "error";
/** The Sign-in Helper closes a bridged tab after 3 s; count down the same span. */
const HANDOFF_CLOSE_MS = 3000;
const OPENER_CLOSE_MS = 1500;
export default function CallbackPage() {
  const [status, setStatus] = useState<CallbackStatus>("processing");
  const [currentUrl] = useState(() => (typeof window === "undefined" ? "" : window.location.href));
  const [attempt, setAttempt] = useState<SignInAttempt | null>(null);
  const [providerError, setProviderError] = useState("");
  const [closeIn, setCloseIn] = useState<number | null>(null);
  const [viaHandoff, setViaHandoff] = useState(false);
  const t = useTranslations("auth");
  const ts = useTranslations("oauthModal");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    const errorDescription = params.get("error_description");

    // Zed native-app sign-in: the redirect carries user_id + access_token and no
    // ?code= — the FULL URL is the exchange payload (zed-hosted's exchangeToken
    // parses and RSA-decrypts it server-side). Rewritten here from `/` by the
    // root page handler so the waiting OAuth modal receives it via the same
    // postMessage/BroadcastChannel/localStorage relay as every other provider.
    const zedAccessToken = params.get("access_token") || params.get("accessToken");
    if (!code && zedAccessToken && (params.get("user_id") || params.get("userId"))) {
      code = window.location.href;
    }

    const callbackData = {
      code,
      state,
      error,
      errorDescription,
      fullUrl: window.location.href,
    };

    let sent = false;
    let openerSameOrigin = false;
    const queueStatusUpdate = (nextStatus: CallbackStatus) => {
      queueMicrotask(() => setStatus(nextStatus));
    };
    const knownAttempt = takeSignInAttempt(state);
    if (knownAttempt) queueMicrotask(() => setAttempt(knownAttempt));
    // Counts down, then closes the tab (a script-opened tab may close itself); if the
    // browser refuses, the page settles on "close this tab now".
    const closeAfter = (ms: number) => {
      queueMicrotask(() => setCloseIn(Math.ceil(ms / 1000)));
      const tick = setInterval(() => setCloseIn((s) => (s && s > 1 ? s - 1 : s)), 1000);
      setTimeout(() => {
        clearInterval(tick);
        window.close();
        setTimeout(() => setStatus("done"), 500);
      }, ms);
    };

    if (window.opener) {
      try {
        openerSameOrigin = window.opener.location.origin === window.location.origin;
      } catch {
        openerSameOrigin = false;
      }
    }

    // Method 1: postMessage to opener (popup mode).
    // May be null when Google OAuth's COOP header severs the opener reference.
    //
    // Only relay {code, state} to a known-trusted target origin. A wildcard "*"
    // here would leak the OAuth code/state to a hostile opener — e.g. a page
    // that opened this callback URL in a popup to phish the code. The browser
    // delivers postMessage only when the opener's origin matches `targetOrigin`,
    // so iterating over an allowlist lets the same-origin parent and Codex's
    // fixed loopback helper receive it while silently dropping it for any other
    // origin. Methods 2 (BroadcastChannel) and 3 (localStorage) cover the
    // same-origin fallback when the opener was severed by COOP.
    const trustedTargetOrigins = [
      window.location.origin, // Same origin (dashboard popup mode).
      // Loopback hostname variants of the same port: the dashboard may be open
      // on 127.0.0.1:PORT while Zed's redirect (or vice versa) lands on
      // localhost:PORT — both names are the operator's own machine, so the
      // callback may be delivered to either. Same rationale as the 1455 entries.
      ...(window.location.port
        ? [`http://localhost:${window.location.port}`, `http://127.0.0.1:${window.location.port}`]
        : []),
      "http://localhost:1455", // Codex helper (fixed loopback port).
      "http://127.0.0.1:1455", // Same Codex helper, IPv4 literal form.
    ];
    if (window.opener) {
      for (const origin of trustedTargetOrigins) {
        try {
          window.opener.postMessage({ type: "oauth_callback", data: callbackData }, origin);
          sent = true;
        } catch (e) {
          console.log("postMessage failed:", e);
        }
      }
    }

    // Method 2: BroadcastChannel — works across browsing context groups for same origin.
    try {
      const channel = new BroadcastChannel("oauth_callback");
      channel.postMessage(callbackData);
      channel.close();
      sent = true;
    } catch (e) {
      console.log("BroadcastChannel failed:", e);
    }

    // Method 3: localStorage — triggers storage event in all same-origin windows,
    // regardless of browsing context group isolation from COOP.
    try {
      localStorage.setItem(
        "oauth_callback",
        JSON.stringify({ ...callbackData, timestamp: Date.now() })
      );
      sent = true;
    } catch (e) {
      console.log("localStorage failed:", e);
    }

    if (error) {
      // Relayed above so the dialog shows it too; this tab explains and links back.
      queueMicrotask(() => setProviderError(errorDescription || error));
      queueStatusUpdate("error");
    } else if (sent && code) {
      if (window.opener && openerSameOrigin) {
        queueStatusUpdate("success");
        // If close is prevented (browser policy), falls through to the manual close prompt.
        closeAfter(OPENER_CLOSE_MS);
      } else if (knownAttempt) {
        // A Connect dialog on this origin started this attempt and listens on the
        // BroadcastChannel/localStorage relay (e.g. the Sign-in Helper's bridged tab).
        queueMicrotask(() => setViaHandoff(true));
        queueStatusUpdate("success");
        closeAfter(HANDOFF_CLOSE_MS);
      } else {
        // Opened as a tab, opener severed by COOP, or remote dashboard using a
        // loopback/tunnel callback. Keep the full URL visible as a manual fallback
        // in case the opener cannot receive the cross-origin postMessage.
        queueStatusUpdate("manual");
      }
    } else {
      // No code/error in URL or all send methods failed — show URL for manual copy.
      // Batch the URL and status update so they render together (React 18 auto-batching).
      queueStatusUpdate("manual");
    }
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <Card padding="lg" className="w-full max-w-md text-center">
        {status === "processing" && (
          <>
            <div className="size-16 mx-auto mb-4 rounded-full bg-bg-subtle flex items-center justify-center">
              <Spinner size="lg" label={t("processing")} className="text-text-muted" />
            </div>
            <h1 className="ci-heading text-xl mb-2">{t("processing")}</h1>
            <p className="text-text-muted">{t("pleaseWait")}</p>
          </>
        )}

        {(status === "success" || status === "done") && (
          <ProviderSignInStatus
            state="success"
            headingLevel="h1"
            providerId={attempt?.provider}
            providerName={attempt?.providerName}
            title={ts("statusSignedInTitle")}
            description={
              <>
                <p>{ts("statusCloseTab")}</p>
                {status === "success" && closeIn !== null && (
                  <p className="mt-1 text-xs opacity-80">
                    {viaHandoff
                      ? ts("statusTabClosing", { seconds: closeIn })
                      : t("windowWillClose")}
                  </p>
                )}
              </>
            }
          >
            {viaHandoff && (
              <details className="w-full text-left text-xs text-text-muted">
                <summary className="cursor-pointer text-center">{ts("statusCopyUrlHint")}</summary>
                <div className="mt-2 bg-bg-subtle border border-border rounded-lg p-3">
                  <code className="break-all">{currentUrl}</code>
                </div>
              </details>
            )}
          </ProviderSignInStatus>
        )}

        {status === "error" && (
          <ProviderSignInStatus
            state="error"
            headingLevel="h1"
            providerId={attempt?.provider}
            providerName={attempt?.providerName}
            description={providerError || ts("statusFailedFallback")}
          >
            <Button onClick={() => window.location.assign("/dashboard")} fullWidth>
              {ts("statusBackToOmniRoute")}
            </Button>
          </ProviderSignInStatus>
        )}

        {status === "manual" && (
          <>
            <div className="size-16 mx-auto mb-4 rounded-full bg-warning-bg flex items-center justify-center">
              <Icon name="info" size={30} className="text-warning" />
            </div>
            <h1 className="ci-heading text-xl mb-2">{t("copyUrl")}</h1>
            <p className="text-text-muted mb-4">{t("copyUrlManual")}</p>
            <div className="bg-bg-subtle border border-border rounded-lg p-3 text-left">
              <code className="text-xs break-all">{currentUrl}</code>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}
