"use client";

import { Spinner } from "../Loading";
import Button from "@/shared/components/Button";

type OAuthBridgeWaitingStepProps = {
  title: string;
  description: string;
  pasteInsteadLabel: string;
  onPasteInstead: () => void;
};

/** Remote-mode waiting panel while the Sign-in Helper extension carries the OAuth redirect. */
export default function OAuthBridgeWaitingStep({
  title,
  description,
  pasteInsteadLabel,
  onPasteInstead,
}: OAuthBridgeWaitingStepProps) {
  return (
    <div className="text-center py-6">
      <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
        <Spinner size="lg" label={title} />
      </div>
      <h3 className="text-lg mb-2">{title}</h3>
      <p className="text-sm text-text-muted mb-4">{description}</p>
      <Button variant="ghost" onClick={onPasteInstead}>
        {pasteInsteadLabel}
      </Button>
    </div>
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
