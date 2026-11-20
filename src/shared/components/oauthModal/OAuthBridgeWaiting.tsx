"use client";

import Button from "@/shared/components/Button";
import ProviderSignInStatus from "./ProviderSignInStatus";

type OAuthBridgeWaitingStepProps = {
  providerId?: string;
  providerName?: string;
  /** Overrides "Waiting for you to approve on <provider>". */
  title?: string;
  description: string;
  pasteInsteadLabel: string;
  onPasteInstead: () => void;
};

/** Remote-mode waiting panel while the Sign-in Helper extension carries the OAuth redirect. */
export default function OAuthBridgeWaitingStep({
  providerId,
  providerName,
  title,
  description,
  pasteInsteadLabel,
  onPasteInstead,
}: OAuthBridgeWaitingStepProps) {
  return (
    <ProviderSignInStatus
      state="waiting"
      providerId={providerId}
      providerName={providerName}
      title={title}
      description={description}
    >
      <Button variant="ghost" onClick={onPasteInstead}>
        {pasteInsteadLabel}
      </Button>
    </ProviderSignInStatus>
  );
}

/** One-line hint linking to the Sign-in Helper install docs. */
export function OAuthBridgeInstallHint({ label, href }: { label: string; href: string }) {
  return (
    <p className="text-xs text-text-muted mb-3">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        {label}
      </a>
    </p>
  );
}
