"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Button from "@/shared/components/Button";
import Checkbox from "@/shared/components/Checkbox";
import { Spinner } from "../Loading";
import { originHost } from "./helperExtension";
import type { HelperSetup } from "./useHelperSetup";

type HelperSetupStepProps = {
  helper: HelperSetup;
  /** Switches the dialog to its manual paste flow. */
  onPasteInstead: () => void;
};

/**
 * One-click Sign-in Helper onboarding: add the extension, allow it on this dashboard, then the
 * sign-in continues by itself. Rendered only while the flow would use the bridge.
 */
export default function HelperSetupStep({ helper, onPasteInstead }: HelperSetupStepProps) {
  const t = useTranslations("oauthModal");
  const [always, setAlways] = useState(false);
  const host = typeof window === "undefined" ? "" : originHost(window.location.origin);
  const view = helper.view === "none" ? "ready" : helper.view;

  const pasteInstead = () => {
    helper.skip(always);
    onPasteInstead();
  };

  return (
    <div className="py-4 flex flex-col gap-4" data-testid="oauth-helper-setup" data-view={view}>
      {view === "absent" && (
        <>
          <div>
            <h3 className="text-lg mb-1">{t("helperAbsentTitle")}</h3>
            <p className="text-sm text-text-muted">{t("helperAbsentDescription")}</p>
          </div>
          <Button onClick={helper.install} fullWidth>
            {t("helperInstall")}
          </Button>
          <p className="text-xs text-text-muted" role="status">
            {t("helperWaitingInstall")}
          </p>
        </>
      )}
      {view === "installed" && (
        <>
          <div>
            <h3 className="text-lg mb-1">{t("helperInstalledTitle")}</h3>
            <p className="text-sm text-text-muted">{t("helperInstalledDescription")}</p>
          </div>
          <Button onClick={helper.allow} fullWidth>
            {t("helperAllow", { host })}
          </Button>
          <p className="text-xs text-text-muted" role="status">
            {t("helperWaitingAllow")}
          </p>
        </>
      )}
      {view === "ready" &&
        (helper.awaitingContinue ? (
          <>
            <div>
              <h3 className="text-lg mb-1">{t("helperReadyTitle")}</h3>
              <p className="text-sm text-text-muted">{t("helperReadyDescription")}</p>
            </div>
            <Button onClick={helper.continueNow} fullWidth>
              {t("helperContinue")}
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-3" role="status">
            <Spinner size="sm" label={t("helperContinuing")} />
            <span className="text-sm">{t("helperContinuing")}</span>
          </div>
        ))}
      {view !== "ready" && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <Button variant="ghost" onClick={pasteInstead}>
            {t("helperPasteInstead")}
          </Button>
          <Checkbox
            label={<span className="text-xs text-text-muted">{t("helperAlwaysPaste")}</span>}
            checked={always}
            onChange={(event) => setAlways(event.target.checked)}
          />
        </div>
      )}
    </div>
  );
}

/** One line under the paste flow when this browser cannot run the helper. */
export function HelperUnsupportedNote({ helper }: { helper: Pick<HelperSetup, "probe"> }) {
  const t = useTranslations("oauthModal");
  if (helper.probe !== "unsupported") return null;
  return <p className="text-xs text-text-muted mb-3">{t("helperUnsupported")}</p>;
}
