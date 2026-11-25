import type { DesktopArtifactAppInstallResult } from "@specweave-studio/contracts";
import { AppWindowIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useTx, type TranslatePhrase } from "../../i18n";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

interface InstallAsAppButtonProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly attachmentId: string;
  readonly title: string;
}

/**
 * Installs a report page as an app on this computer. Desktop only: the shell
 * confirms in a native dialog, writes the launcher and opens the app's window,
 * so web and phone clients, and desktop builds without the bridge method,
 * show nothing.
 */
export function InstallAsAppButton(props: InstallAsAppButtonProps) {
  const tx = useTx();
  const [busy, setBusy] = useState(false);
  // A second click while the shell's dialog is up must not ask again.
  const pending = useRef(false);
  // Read at render, not import: the bridge belongs to this window.
  const install =
    typeof window === "undefined" ? undefined : window.desktopBridge?.installArtifactApp;
  if (typeof install !== "function") return null;

  const onClick = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await install({
        environmentId: props.environmentId,
        threadId: props.threadId,
        attachmentId: props.attachmentId,
        title: props.title,
      });
      announceInstallResult(result, tx);
    } catch (error) {
      announceInstallResult(
        {
          status: "failed",
          message: error instanceof Error && error.message ? error.message : "",
        },
        tx,
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={() => void onClick()} disabled={busy}>
      <AppWindowIcon aria-hidden className="size-4" /> {tx("Install as app")}
    </Button>
  );
}

/** Tells the person what the shell did; a cancelled dialog needs no reply. */
export function announceInstallResult(
  result: DesktopArtifactAppInstallResult,
  tx: TranslatePhrase,
): void {
  switch (result.status) {
    case "installed":
      toastManager.add({
        type: "success",
        title: tx("{name} is installed. It opens in its own window.", { name: result.app.name }),
      });
      return;
    case "already-installed":
      toastManager.add({
        type: "info",
        title: tx("{name} is already installed.", { name: result.app.name }),
      });
      return;
    case "failed":
      toastManager.add({
        type: "error",
        title: tx("Could not install the app"),
        description: result.message || tx("An error occurred."),
      });
      return;
    case "cancelled":
      return;
  }
}
