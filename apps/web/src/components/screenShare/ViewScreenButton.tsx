/**
 * "View screen" on another machine's card (1490). Shown only where that
 * machine says it can share its screen. Whether it does is decided there: by
 * its switch, and by a person at it the first time.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { MonitorIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTx } from "../../i18n";
import { useServerConfigs } from "../../state/entities";
import { Button } from "../ui/button";
import { Dialog, DialogOverlayPopup } from "../ui/dialog";
import { browserMachineKeyPins, browserScreenViewerDeps } from "./screenShareBrowser";
import { ScreenViewerSession } from "./screenShareClient";
import { ScreenViewerView, clearScreenFrame, paintScreenFrame } from "./ScreenViewer";
import { initialScreenViewer, type ScreenViewerModel } from "./screenViewer.logic";

/** One view, start to end. A new one (View again) is a new instance. */
function ScreenViewerRun({
  environmentId,
  machine,
  onClose,
  onRetry,
}: {
  environmentId: EnvironmentId;
  machine: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<ScreenViewerSession | null>(null);
  const [model, setModel] = useState<ScreenViewerModel>(() => initialScreenViewer(Date.now()));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const session = new ScreenViewerSession({
      ...browserScreenViewerDeps(environmentId),
      onModel: setModel,
      draw: (header, jpeg) => paintScreenFrame(canvasRef.current, header, jpeg),
      clear: () => clearScreenFrame(canvasRef.current),
    });
    sessionRef.current = session;
    session.start();
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
  }, [environmentId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  // While this window shows another machine's screen, computer use here holds off:
  // its screenshots would carry that screen into a thread.
  useEffect(() => {
    const bridge = window.desktopBridge?.screenShare;
    void bridge?.setViewing(true);
    return () => {
      void bridge?.setViewing(false);
    };
  }, []);

  return (
    <ScreenViewerView
      machine={machine}
      model={model}
      now={now}
      canvasRef={canvasRef}
      onTypedCode={(code) => sessionRef.current?.typedCode(code)}
      onChooseDisplay={(displayId) => sessionRef.current?.chooseDisplay(displayId)}
      onEnd={() => sessionRef.current?.end()}
      onClose={onClose}
      onRetry={onRetry}
      onForgetKey={() => {
        browserMachineKeyPins.forget(environmentId);
        onRetry();
      }}
    />
  );
}

/** The viewer over the window. Closing it ends the view. */
function ScreenViewer({
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
  const [attempt, setAttempt] = useState(0);
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
          <ScreenViewerRun
            key={attempt}
            environmentId={environmentId}
            machine={machine}
            onClose={onClose}
            onRetry={() => setAttempt((value) => value + 1)}
          />
        ) : null}
      </DialogOverlayPopup>
    </Dialog>
  );
}

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
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-view-screen="">
        <MonitorIcon />
        {tx("View screen")}
      </Button>
      <ScreenViewer
        environmentId={environmentId}
        machine={name}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
