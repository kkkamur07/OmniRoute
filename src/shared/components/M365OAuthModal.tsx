"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import Modal from "./Modal";
import Button from "./Button";
import Input from "./Input";
import OAuthBridgeWaitingStep from "./oauthModal/OAuthBridgeWaiting";
import {
  isTrueLocalhostHost,
  shouldUseBridge,
  useOAuthBridge,
  useOAuthCallbackRelay,
} from "./oauthModal/useOAuthBridge";

const PROVIDER = "copilot-m365-web";
const NATIVE_REDIRECT = "https://login.microsoftonline.com/common/oauth2/nativeclient";
const attemptSchema = z.object({
  authUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.origin === "https://login.microsoftonline.com" && !url.username && !url.password;
  }),
  state: z.string().min(1),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  redirectUri: z.literal(NATIVE_REDIRECT),
  flowType: z.string().min(1),
  expiresAt: z.number().int().nonnegative().max(8640000000000000).optional(),
});
type Attempt = z.infer<typeof attemptSchema>;
type Props = {
  onClose: () => void;
  onSuccess?: () => void;
  connectionId?: string;
};

function validateCallback(code: string, state: string): void {
  const url = new URL(code);
  if (
    `${url.origin}${url.pathname}` !== NATIVE_REDIRECT ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("code").length !== 1 ||
    !url.searchParams.get("code")?.trim() ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== state ||
    url.searchParams.has("error")
  )
    throw new Error();
}

async function fetchAttempt(connectionId: string | undefined, signal: AbortSignal) {
  const query = connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : "";
  const res = await fetch(`/api/oauth/copilot-m365-web/authorize${query}`, {
    signal,
    cache: "no-store",
  });
  const data: unknown = await res.json();
  if (signal.aborted) return null;
  const parsed = attemptSchema.safeParse(data);
  if (!res.ok || !parsed.success) throw new Error();
  return parsed.data;
}

async function exchangeAttempt(
  attempt: Attempt,
  code: string,
  connectionId: string | undefined,
  signal: AbortSignal
) {
  const res = await fetch("/api/oauth/copilot-m365-web/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      code,
      redirectUri: attempt.redirectUri,
      codeVerifier: attempt.codeVerifier,
      state: attempt.state,
      ...(connectionId ? { connectionId } : {}),
    }),
  });
  const data: unknown = await res.json();
  if (signal.aborted) return;
  if (!res.ok || !z.object({ success: z.literal(true) }).safeParse(data).success) throw new Error();
}

// Mounted only while open; keying by connectionId isolates reauthentication targets.
function useM365OAuthFlow({ onClose, onSuccess, connectionId }: Props) {
  const t = useTranslations("oauthModal");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [credentialUrl, setCredentialUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "preparing" | "ready" | "exchanging" | "success">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);
  const { bridgeVersion, arm } = useOAuthBridge();
  const [bridgeArmed, setBridgeArmed] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  const clear = () => {
    active.current?.abort();
    active.current = null;
    setAttempt(null);
    setCredentialUrl("");
    setError(null);
    setBridgeArmed(false);
    setStatus("idle");
  };
  const close = () => {
    clear();
    onClose();
  };
  const prepare = async () => {
    clear();
    const controller = new AbortController();
    active.current = controller;
    setStatus("preparing");
    try {
      const nextAttempt = await fetchAttempt(connectionId, controller.signal);
      if (!nextAttempt || controller.signal.aborted) return;
      const isTrueLocalhost = isTrueLocalhostHost(window.location.hostname);
      // Bridge: the armed extension sends the nativeclient redirect for this state to /callback.
      const armed =
        shouldUseBridge({ provider: PROVIDER, isTrueLocalhost, bridgeVersion }) &&
        (await arm({
          provider: PROVIDER,
          state: nextAttempt.state,
          redirectUri: nextAttempt.redirectUri,
        }));
      if (controller.signal.aborted) return;
      setAttempt(nextAttempt);
      setBridgeArmed(armed);
      setStatus("ready");
      if (armed) window.open(nextAttempt.authUrl, "_blank", "noopener,noreferrer");
    } catch {
      if (controller.signal.aborted) return;
      setError(t("m365PrepareError"));
      setStatus("idle");
    }
  };
  const exchange = async (current: Attempt, code: string) => {
    setError(null);
    setBridgeArmed(false);
    try {
      validateCallback(code, current.state);
    } catch {
      setError(t("m365InvalidCallback"));
      return;
    }
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setStatus("exchanging");
    try {
      await exchangeAttempt(current, code, connectionId, controller.signal);
      if (controller.signal.aborted) return;
      setCredentialUrl("");
      setAttempt(null);
      setStatus("success");
      onSuccess?.();
    } catch {
      if (controller.signal.aborted) return;
      setCredentialUrl("");
      setAttempt(null);
      setError(t("m365ExchangeError"));
      setStatus("idle");
    }
  };

  const submit = async () => {
    if (!attempt || status !== "ready") return;
    await exchange(attempt, credentialUrl.trim());
  };
  // Sign-in Helper relay: rebuild the nativeclient URL the exchange expects from code + state.
  useOAuthCallbackRelay(status === "ready" ? attempt?.state : undefined, (relay) => {
    if (!attempt) return;
    if (relay.error || !relay.code) {
      setBridgeArmed(false);
      setError(t("m365ExchangeError"));
      return;
    }
    void exchange(attempt, buildNativeRedirectUrl(relay.code, attempt.state));
  });

  return {
    ...{ attempt, credentialUrl, setCredentialUrl, status, error, close, prepare, submit },
    ...{ bridgeArmed, setBridgeArmed },
  };
}

/** The nativeclient redirect URL (what the manual paste carries) for a relayed code + state. */
export function buildNativeRedirectUrl(code: string, state: string): string {
  return `${NATIVE_REDIRECT}?${new URLSearchParams({ code, state })}`;
}

function M365AttemptExpiry({ expiresAt }: { expiresAt?: number }) {
  const t = useTranslations("oauthModal");
  return (
    <>
      {expiresAt !== undefined && (
        <p className="text-sm text-text-muted">
          {t("m365UrlExpires")}{" "}
          <time dateTime={new Date(expiresAt).toISOString()}>
            {new Date(expiresAt).toISOString()}
          </time>{" "}
          {t("m365UrlExpiredHint")}
        </p>
      )}
    </>
  );
}

function M365SignInInstructions() {
  const t = useTranslations("oauthModal");
  return (
    <>
      <ol className="list-decimal ps-5 space-y-2 text-sm">
        <li>{t("m365StepPrepare")}</li>
        <li>{t("m365StepOpen")}</li>
        <li>{t("m365StepNetwork")}</li>
        <li>{t("m365StepNavigate")}</li>
        <li>{t("m365StepCopy")}</li>
      </ol>
      <p className="text-sm text-text-muted">{t("m365PrivateUrlHint")}</p>
    </>
  );
}

export default function M365OAuthModal(props: Props) {
  const t = useTranslations("oauthModal");
  const flow = useM365OAuthFlow(props);
  const { attempt, credentialUrl, setCredentialUrl, status, error, close, prepare, submit } = flow;

  return (
    <Modal isOpen onClose={close} title={t("m365Title")} size="lg">
      <div className="flex flex-col gap-4">
        {status === "success" ? (
          <>
            <p role="status">{t("success")}</p>
            <Button onClick={close}>{t("done")}</Button>
          </>
        ) : (
          <>
            {flow.bridgeArmed ? (
              <OAuthBridgeWaitingStep
                title={t("bridgeWaitingTitle")}
                description={t("bridgeWaitingDescription")}
                pasteInsteadLabel={t("bridgePasteInstead")}
                onPasteInstead={() => flow.setBridgeArmed(false)}
              />
            ) : (
              <M365SignInInstructions />
            )}
            {status === "preparing" && <p role="status">{t("m365Preparing")}</p>}
            {attempt && !flow.bridgeArmed && (
              <>
                <a
                  href="about:blank"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {t("m365OpenSignIn")}
                </a>
                <Input
                  label={t("m365AuthUrlLabel")}
                  type="text"
                  readOnly
                  autoComplete="off"
                  value={attempt.authUrl}
                  hint={t("m365AuthUrlCopyHint")}
                />
                <M365AttemptExpiry expiresAt={attempt.expiresAt} />
                <Input
                  label={t("m365CallbackLabel")}
                  type="password"
                  autoComplete="off"
                  value={credentialUrl}
                  onChange={(event) => setCredentialUrl(event.target.value)}
                  disabled={status === "exchanging"}
                />
                <Button
                  onClick={() => void submit()}
                  disabled={!credentialUrl.trim() || status === "exchanging"}
                >
                  {status === "exchanging" ? t("m365Connecting") : t("connect")}
                </Button>
              </>
            )}
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => void prepare()}
                disabled={status === "preparing"}
              >
                {attempt ? t("m365NewAttempt") : t("m365Prepare")}
              </Button>
              <Button variant="ghost" onClick={close}>
                {t("cancel")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
