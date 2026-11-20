"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import Icon from "@/shared/components/Icon";
import OmniRouteLogo from "@/shared/components/OmniRouteLogo";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { cn } from "@/shared/utils/cn";

export type ProviderSignInState = "waiting" | "success" | "error";

type ProviderSignInStatusProps = {
  state: ProviderSignInState;
  /** Provider id used to resolve the logo; omitted renders the generic provider glyph. */
  providerId?: string | null;
  /** Display name ("OpenAI Codex"); omitted falls back to a neutral "your provider". */
  providerName?: string | null;
  /** Overrides the default per-state title. */
  title?: ReactNode;
  /** Secondary line under the title (instructions, close hint, error text). */
  description?: ReactNode;
  /** Account email or label, shown once known. */
  account?: string | null;
  /** The page-level heading on the standalone callback tab; h3 inside a dialog. */
  headingLevel?: "h1" | "h3";
  /** Actions (Done, Back to OmniRoute, Paste instead). */
  children?: ReactNode;
  className?: string;
};

const BUBBLE =
  "relative size-14 shrink-0 rounded-2xl border border-border bg-surface shadow-sm flex items-center justify-center";

function Connector({ state }: { state: ProviderSignInState }) {
  return (
    <div className="relative flex-1 min-w-10 max-w-24 h-6 flex items-center" aria-hidden="true">
      <div
        className={cn(
          "w-full border-t-2",
          state === "success" && "border-success",
          state === "waiting" && "border-dashed border-primary/40",
          state === "error" && "border-dashed border-error/50"
        )}
      />
      {state === "waiting" && (
        <span className="absolute left-1/2 -translate-x-1/2 size-2.5 rounded-full bg-primary motion-safe:animate-pulse" />
      )}
      {state === "success" && (
        <span className="absolute left-1/2 -translate-x-1/2 size-6 rounded-full bg-success text-white flex items-center justify-center motion-safe:animate-[ping_0.6s_ease-out_1_reverse]">
          <Icon name="check" size={14} />
        </span>
      )}
      {state === "error" && (
        <span className="absolute left-1/2 -translate-x-1/2 size-6 rounded-full bg-error text-white flex items-center justify-center">
          <Icon name="close" size={14} />
        </span>
      )}
    </div>
  );
}

/**
 * The one sign-in status panel (waiting / success / error): OmniRoute and the provider logo
 * joined by a line that animates while waiting and turns into a check on success. Used by the
 * Connect dialogs and the standalone /callback tab. Motion is skipped under
 * prefers-reduced-motion (Tailwind `motion-safe:`).
 */
export default function ProviderSignInStatus({
  state,
  providerId,
  providerName,
  title,
  description,
  account,
  headingLevel = "h3",
  children,
  className,
}: ProviderSignInStatusProps) {
  const t = useTranslations("oauthModal");
  // Translate lazily: a caller that passes every string never needs the oauthModal namespace.
  const name = providerName || t("statusProviderFallbackName");
  const defaultTitle = () =>
    state === "success"
      ? t("statusConnectedTitle", { providerName: name })
      : state === "waiting"
        ? t("statusWaitingTitle", { providerName: name })
        : t("statusFailedTitle");
  const Heading = headingLevel;

  return (
    <div
      className={cn("mx-auto w-full max-w-sm px-2 py-6 text-center", className)}
      data-sign-in-state={state}
    >
      <div className="mb-6 flex items-center justify-center gap-3">
        <div className={BUBBLE} title="OmniRoute">
          <OmniRouteLogo size={30} />
        </div>
        <Connector state={state} />
        <div className={BUBBLE} title={name}>
          {providerId ? (
            <ProviderIcon providerId={providerId} size={30} alt={name} />
          ) : (
            <Icon name="key" size={26} className="text-text-muted" />
          )}
          {state === "waiting" && (
            <span
              className="absolute -inset-1 rounded-[1.1rem] border-2 border-primary/30 motion-safe:animate-pulse"
              aria-hidden="true"
            />
          )}
        </div>
      </div>

      <div role={state === "error" ? "alert" : "status"} aria-live="polite">
        <Heading className="ci-heading text-lg font-semibold text-text-main mb-1 text-balance">
          {title ?? defaultTitle()}
        </Heading>
        {account && (
          <p className="text-sm text-text-muted mb-1 break-all">
            {t("statusSignedInAs", { account })}
          </p>
        )}
      </div>
      {description && (
        <div
          className={cn(
            "mt-2 text-sm text-pretty",
            state === "error" ? "text-error break-words" : "text-text-muted"
          )}
        >
          {description}
        </div>
      )}
      {children && <div className="mt-6 flex flex-col items-center gap-2">{children}</div>}
    </div>
  );
}
