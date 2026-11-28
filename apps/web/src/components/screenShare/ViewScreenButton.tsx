/**
 * "View screen" on another machine's card (1490). Shown only where that
 * machine says it can share its screen. Whether it does is decided there: by
 * its switch, and by a person at it the first time.
 *
 * In the desktop app the screen opens in a window of its own, one per machine
 * (1519), so several machines can be watched side by side; "View in this
 * window" keeps the view over this window. A browser tab has no windows to
 * open and shows the view over the page.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { ChevronDownIcon, MonitorIcon } from "lucide-react";
import { useState } from "react";

import { useTx } from "../../i18n";
import { useServerConfigs } from "../../state/entities";
import { Button } from "../ui/button";
import { Dialog, DialogOverlayPopup } from "../ui/dialog";
import { Group } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { ScreenViewerRun } from "./ScreenViewerRun";

/** The viewer over the window. Closing it ends the view. */
function ScreenViewerDialog({
  environmentId,
  machine,
  open,
  onClose,
}: {
  environmentId: EnvironmentId;
  machine: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      modal={false}
      disablePointerDismissal
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogOverlayPopup
        // A press beside the card does not end a view someone is watching; End and Escape do.
        onBackdropClick={() => {}}
        aria-label={`Screen of ${machine}`}
        data-screen-viewer-overlay=""
      >
        {open ? (
          <ScreenViewerRun environmentId={environmentId} machine={machine} onClose={onClose} />
        ) : null}
      </DialogOverlayPopup>
    </Dialog>
  );
}

const NAME_MAX = 120;

export function ViewScreenButton({
  environmentId,
  name,
}: {
  environmentId: EnvironmentId;
  /** The machine's name, as its card shows it. */
  name: string;
}) {
  const tx = useTx();
  const configs = useServerConfigs();
  const [open, setOpen] = useState(false);
  if (configs.get(environmentId)?.environment.capabilities.screenShare !== true) return null;
  const openViewer = window.desktopBridge?.screenShare?.openViewer;

  const inThisWindow = (
    <ScreenViewerDialog
      environmentId={environmentId}
      machine={name}
      open={open}
      onClose={() => setOpen(false)}
    />
  );
  if (openViewer === undefined)
    return (
      <>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-view-screen="">
          <MonitorIcon />
          {tx("View screen")}
        </Button>
        {inThisWindow}
      </>
    );

  const inOwnWindow = () => {
    void openViewer({ environmentId, name: name.slice(0, NAME_MAX) }).then(
      (result) => {
        if (result === "limit")
          toastManager.add({
            type: "info",
            title: tx("Too many screens are open"),
            description: tx("Close one of the screen windows, then open this one again."),
          });
        else if (result === "failed" || result === "invalid")
          toastManager.add({ type: "error", title: tx("Could not open the screen window") });
      },
      () => toastManager.add({ type: "error", title: tx("Could not open the screen window") }),
    );
  };
  return (
    <>
      <Group>
        <Button size="sm" variant="outline" onClick={inOwnWindow} data-view-screen="">
          <MonitorIcon />
          {tx("View screen")}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                aria-label={tx("More ways to view")}
                data-view-screen-more=""
              >
                <ChevronDownIcon />
              </Button>
            }
          />
          <MenuPopup align="end">
            <MenuItem onClick={inOwnWindow}>{tx("View in its own window")}</MenuItem>
            <MenuItem onClick={() => setOpen(true)} data-view-screen-here="">
              {tx("View in this window")}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </Group>
      {inThisWindow}
    </>
  );
}
