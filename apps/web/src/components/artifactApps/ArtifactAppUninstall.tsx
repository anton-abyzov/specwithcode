import { MoreHorizontalIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTx } from "~/i18n";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

/**
 * The installed page window's quiet way out: a small More menu in the header
 * whose one item asks before it removes the app. The page's own macOS app menu
 * asks through the shell, and lands on the same question here, in the window.
 */
export function ArtifactAppUninstallMenu(props: {
  readonly name: string;
  readonly installId: string;
}) {
  const tx = useTx();
  const { name, installId } = props;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Older shells have no app menu request; the header menu still works there.
  useEffect(() => {
    const subscribe = window.desktopBridge?.onArtifactAppUninstallRequest;
    if (typeof subscribe !== "function") return;
    return subscribe(() => setConfirming(true));
  }, []);
  const onUninstall = async () => {
    const uninstall = window.desktopBridge?.uninstallArtifactApp;
    setConfirming(false);
    if (typeof uninstall !== "function" || busy) return;
    setBusy(true);
    const removed = await uninstall({ installId }).catch(() => false);
    if (removed) {
      // The install is gone; this window has nothing left to show.
      window.close();
      return;
    }
    setBusy(false);
    toastManager.add({ type: "error", title: tx("Could not uninstall the app") });
  };
  return (
    <>
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" size="icon-sm" disabled={busy} aria-label={tx("More")} />}
        >
          <MoreHorizontalIcon aria-hidden className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem variant="destructive" onClick={() => setConfirming(true)}>
            <Trash2Icon aria-hidden />
            {tx("Uninstall {name}…", { name })}
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup initialFocus={cancelRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{tx("Uninstall {name}?", { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {tx(
                "Its launcher is removed from this computer. The page stays in its thread, and you can install it again.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button ref={cancelRef} variant="outline" />}>
              {tx("Cancel")}
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void onUninstall()}>
              {tx("Uninstall")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
