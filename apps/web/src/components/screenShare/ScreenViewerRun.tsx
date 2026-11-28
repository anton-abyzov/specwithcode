/**
 * One view of another machine's screen, start to end (1490, 1519). Used by the
 * dialog over an app window and by a machine's own viewer window. A new view
 * (View again) is a new instance.
 *
 * Before the session starts, the app's main process is told this window now
 * shows a remote screen (computer use here pauses) and keeps one view per
 * machine: when another window already shows it, that window comes forward and
 * this one starts nothing.
 */
import type { EnvironmentId, ScreenSharePicture } from "@specweave-studio/contracts";
import { useEffect, useRef, useState } from "react";

import { useTx } from "../../i18n";
import { Button } from "../ui/button";
import { browserMachineKeyPins, browserScreenViewerDeps } from "./screenShareBrowser";
import { ScreenViewerSession } from "./screenShareClient";
import { ScreenViewerView, clearScreenFrame, paintScreenFrame } from "./ScreenViewer";
import { useScreenControlInput } from "./useScreenControlInput";
import {
  initialScreenViewer,
  screenViewerStatsLine,
  type ScreenViewerModel,
  type ScreenViewerStats,
} from "./screenViewer.logic";

const PICTURE_STORAGE_KEY = "specwithcode:screen-share:picture";

const readPicture = (): ScreenSharePicture => {
  try {
    const stored = localStorage.getItem(PICTURE_STORAGE_KEY);
    return stored === "low" || stored === "classic" ? stored : "auto";
  } catch {
    return "auto";
  }
};

const newViewToken = (): string => `view-${crypto.getRandomValues(new Uint32Array(2)).join("-")}`;

type Claim = "asking" | "ok" | "elsewhere";

/** Asks the main process for this view; a browser tab has nobody to ask and always may. */
function useViewClaim(environmentId: EnvironmentId): Claim {
  const [claim, setClaim] = useState<Claim>(() =>
    window.desktopBridge?.screenShare?.beginView === undefined ? "ok" : "asking",
  );
  useEffect(() => {
    const bridge = window.desktopBridge?.screenShare;
    if (bridge?.beginView === undefined) return;
    const token = newViewToken();
    let live = true;
    void bridge.beginView({ token, environmentId }).then(
      (answer) => {
        if (live) setClaim(answer === "ok" ? "ok" : "elsewhere");
      },
      () => {
        if (live) setClaim("elsewhere");
      },
    );
    return () => {
      live = false;
      void bridge.endView?.(token);
    };
  }, [environmentId]);
  return claim;
}

function ScreenViewerSessionRun({
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
  const areaRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<ScreenViewerSession | null>(null);
  const statsRef = useRef<ScreenViewerStats>({ drawnAt: [], bytes: 0 });
  const [model, setModel] = useState<ScreenViewerModel>(() => initialScreenViewer(Date.now()));
  const [now, setNow] = useState(() => Date.now());
  const [picture, setPicture] = useState<ScreenSharePicture>(readPicture);
  const [showStats, setShowStats] = useState(false);
  const [statsLine, setStatsLine] = useState("");

  useEffect(() => {
    const session = new ScreenViewerSession({
      ...browserScreenViewerDeps(environmentId),
      onModel: setModel,
      draw: async (header, jpeg) => {
        await paintScreenFrame(canvasRef.current, header, jpeg);
        const stats = statsRef.current;
        const at = performance.now();
        stats.drawnAt = [...stats.drawnAt.filter((then) => at - then < 5_000), at];
        stats.bytes = jpeg.length;
        stats.header = header;
      },
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

  useEffect(() => {
    if (!showStats) return;
    const timer = setInterval(
      () => setStatsLine(screenViewerStatsLine(statsRef.current, performance.now())),
      1_000,
    );
    return () => clearInterval(timer);
  }, [showStats]);

  // The picture area in device pixels, so the machine sends a picture that fits it.
  useEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const say = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(area.clientWidth * ratio));
      const height = Math.max(1, Math.round(area.clientHeight * ratio));
      sessionRef.current?.setViewport({ width, height, picture });
    };
    say();
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(say, 250);
    });
    observer.observe(area);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [picture]);

  const live = model.phase.kind === "live" ? model.phase : null;
  const [keyboardHere, setKeyboardHere] = useState(false);
  useScreenControlInput({
    enabled: live !== null && !live.locked && model.control.mode === "controlling",
    canvasRef,
    focusRef: areaRef,
    displayId: live?.displayId ?? null,
    send: (displayId, events) => sessionRef.current?.sendInput(displayId, events),
    onKeyboard: setKeyboardHere,
  });

  return (
    <ScreenViewerView
      machine={machine}
      model={model}
      now={now}
      canvasRef={canvasRef}
      areaRef={areaRef}
      keyboardHere={keyboardHere}
      picture={picture}
      onPicture={(next) => {
        setPicture(next);
        try {
          localStorage.setItem(PICTURE_STORAGE_KEY, next);
        } catch {
          // Not kept: the next view starts at Auto.
        }
      }}
      statsLine={showStats ? statsLine : null}
      onToggleStats={() => setShowStats((value) => !value)}
      onRequestControl={() => sessionRef.current?.requestControl()}
      onStopControl={() => sessionRef.current?.stopControl()}
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

/** A view that first makes sure no other window shows this machine. */
function ScreenViewerClaimed(props: {
  environmentId: EnvironmentId;
  machine: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  const tx = useTx();
  const claim = useViewClaim(props.environmentId);
  if (claim === "ok") return <ScreenViewerSessionRun {...props} />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-muted p-6">
      <div
        className="w-full max-w-md rounded-xl border border-border bg-popover p-5 text-center text-popover-foreground shadow-lg"
        role="status"
        data-screen-elsewhere={claim}
      >
        <p className="text-sm">
          {claim === "asking"
            ? tx("Opening the screen of {machine}…", { machine: props.machine })
            : tx("The screen of {machine} is already open in another window.", {
                machine: props.machine,
              })}
        </p>
        {claim === "elsewhere" ? (
          <Button className="mt-4" variant="outline" onClick={props.onClose}>
            {tx("Close")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** One view; View again starts a new one. */
export function ScreenViewerRun({
  environmentId,
  machine,
  onClose,
}: {
  environmentId: EnvironmentId;
  machine: string;
  onClose: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ScreenViewerClaimed
      key={attempt}
      environmentId={environmentId}
      machine={machine}
      onClose={onClose}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}
