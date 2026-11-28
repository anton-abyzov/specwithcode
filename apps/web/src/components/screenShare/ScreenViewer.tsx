/**
 * Another machine's screen, in this window (1490). View only: nothing typed or
 * clicked here reaches that machine.
 *
 * `ScreenViewerView` takes plain props, so the app and the fixture under
 * tests/screen-share render the same thing. `ViewScreenButton.tsx` adds the
 * session and the overlay.
 */
import type { ScreenShareFrameHeader, ScreenSharePicture } from "@specweave-studio/contracts";
import { ActivityIcon, MonitorIcon, MonitorOffIcon, ShieldAlertIcon } from "lucide-react";
import { type FormEvent, type RefObject, useState } from "react";

import { useTx } from "../../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
  screenShareCodeDigits,
  screenViewerCanRetry,
  screenViewerEndWords,
  screenViewerPhaseWords,
  screenViewerTimeLeft,
  type ScreenViewerModel,
} from "./screenViewer.logic";

/** Puts one frame on the canvas, with the machine's pointer where the frame says it is. */
export async function paintScreenFrame(
  canvas: HTMLCanvasElement | null,
  header: ScreenShareFrameHeader,
  jpeg: Uint8Array,
): Promise<void> {
  if (canvas === null) return;
  const bitmap = await createImageBitmap(
    new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
  );
  if (canvas.width !== header.width) canvas.width = header.width;
  if (canvas.height !== header.height) canvas.height = header.height;
  const context = canvas.getContext("2d");
  if (context === null) return bitmap.close();
  context.drawImage(bitmap, 0, 0, header.width, header.height);
  bitmap.close();
  paintScreenPointer(canvas, header.pointer);
}

/** The pointer is a picture of where it is, not a pointer: it clicks nothing. */
export function paintScreenPointer(
  canvas: HTMLCanvasElement,
  pointer: ScreenShareFrameHeader["pointer"],
): void {
  const context = canvas.getContext("2d");
  if (context === null || pointer === undefined) return;
  const radius = Math.max(6, Math.round(canvas.width / 240));
  context.beginPath();
  context.arc(pointer.x, pointer.y, radius, 0, Math.PI * 2);
  context.fillStyle = "rgba(20, 20, 20, 0.85)";
  context.fill();
  context.lineWidth = Math.max(2, radius / 3);
  context.strokeStyle = "#ffffff";
  context.stroke();
}

export function clearScreenFrame(canvas: HTMLCanvasElement | null): void {
  canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

function CodeForm({
  triesHere,
  wrong,
  sent,
  onTypedCode,
}: {
  triesHere: number;
  wrong: boolean;
  sent: boolean;
  onTypedCode: (code: string) => void;
}) {
  const tx = useTx();
  const [code, setCode] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (code.length !== 6 || sent) return;
    onTypedCode(code);
    setCode("");
  };
  return (
    <form className="mt-4 space-y-2" onSubmit={submit} data-screen-code-form="">
      <label className="block text-sm font-medium" htmlFor="screen-share-code">
        {tx("Code on that machine's screen")}
      </label>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Input
          id="screen-share-code"
          className="w-36"
          font="mono"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          placeholder="000000"
          aria-invalid={wrong ? true : undefined}
          aria-describedby={wrong ? "screen-share-code-error" : undefined}
          disabled={sent}
          value={code}
          onChange={(event) => setCode(screenShareCodeDigits(event.target.value))}
        />
        <Button type="submit" disabled={code.length !== 6 || sent}>
          {tx("Continue")}
        </Button>
      </div>
      {wrong ? (
        <p
          id="screen-share-code-error"
          role="alert"
          className="text-sm text-destructive-foreground"
        >
          {tx(
            triesHere === 1
              ? "That is not the code. 1 try left."
              : "That is not the code. {tries} tries left.",
            { tries: triesHere },
          )}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {tx("The code is shown only on that machine. Nothing is shown here until it matches.")}
        </p>
      )}
    </form>
  );
}

export interface ScreenViewerViewProps {
  /** The viewed machine's name. */
  machine: string;
  model: ScreenViewerModel;
  /** Epoch milliseconds, for the time left. */
  now: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** The area the picture is fitted into; its size is sent to the machine (1519). */
  areaRef?: RefObject<HTMLDivElement | null>;
  picture?: ScreenSharePicture;
  onPicture?: (picture: ScreenSharePicture) => void;
  /** Frames per second, size and delay, when the person asked to see them; null otherwise. */
  statsLine?: string | null;
  onToggleStats?: () => void;
  onTypedCode: (code: string) => void;
  onChooseDisplay: (displayId: string) => void;
  /** Ends the view; the surface stays to say so. */
  onEnd: () => void;
  onClose: () => void;
  onRetry: () => void;
  /** Forgets the key saved for this machine, then views again. */
  onForgetKey: () => void;
}

export function ScreenViewerView({
  machine,
  model,
  now,
  canvasRef,
  areaRef,
  picture,
  onPicture,
  statsLine,
  onToggleStats,
  onTypedCode,
  onChooseDisplay,
  onEnd,
  onClose,
  onRetry,
  onForgetKey,
}: ScreenViewerViewProps) {
  const tx = useTx();
  const { phase } = model;
  const live = phase.kind === "live";
  const showPicture = live && !phase.locked && model.hasPicture;
  const words = screenViewerPhaseWords(phase);
  const end = phase.kind === "ended" ? phase.end : null;
  const endWords = end === null ? null : screenViewerEndWords(end);
  const warning = end?.kind === "machine_key_changed" || end?.kind === "code_mismatch";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-screen-viewer={phase.kind}>
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 sm:px-4">
        <MonitorIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 truncate text-sm font-semibold">
          {tx("Screen of {machine}", { machine })}
        </h2>
        {live ? (
          <Badge variant={phase.locked ? "warning" : "success"} size="sm" data-screen-status="">
            {phase.locked ? tx("Locked") : tx("Live, view only")}
          </Badge>
        ) : null}
        {live ? (
          <span className="text-xs text-muted-foreground tabular-nums" data-screen-time-left="">
            {tx("Ends in {time}", { time: screenViewerTimeLeft(phase.endsAt, now) })}
          </span>
        ) : null}
        <span className="flex-1" />
        {live && onPicture !== undefined && phase.features.includes("viewport") ? (
          <Button
            size="compact"
            variant={picture === "low" ? "secondary" : "outline"}
            aria-pressed={picture === "low"}
            onClick={() => onPicture(picture === "low" ? "auto" : "low")}
            data-screen-low-bandwidth=""
          >
            {tx("Low bandwidth")}
          </Button>
        ) : null}
        {live && onToggleStats !== undefined ? (
          <Button
            size="compact"
            variant={statsLine == null ? "ghost" : "secondary"}
            aria-pressed={statsLine != null}
            aria-label={tx("Picture details")}
            onClick={onToggleStats}
            data-screen-stats-toggle=""
          >
            <ActivityIcon />
          </Button>
        ) : null}
        {live && phase.displays.length > 1 ? (
          <div
            role="radiogroup"
            aria-label={tx("Display")}
            className="flex flex-wrap items-center gap-1"
            data-screen-displays=""
          >
            {phase.displays.map((display) => (
              <Button
                key={display.id}
                role="radio"
                aria-checked={display.id === phase.displayId}
                size="compact"
                variant={display.id === phase.displayId ? "secondary" : "outline"}
                onClick={() => onChooseDisplay(display.id)}
              >
                {display.label}
              </Button>
            ))}
          </div>
        ) : null}
        {end === null ? (
          <Button size="compact" variant="destructive-outline" onClick={onEnd}>
            {live ? tx("End") : tx("Cancel")}
          </Button>
        ) : (
          <Button size="compact" variant="outline" onClick={onClose}>
            {tx("Close")}
          </Button>
        )}
      </header>

      {statsLine != null ? (
        <p
          className="shrink-0 border-b border-border px-3 py-1 font-mono text-xs text-muted-foreground tabular-nums sm:px-4"
          data-screen-stats=""
        >
          {statsLine === "" ? tx("Waiting for the next picture…") : statsLine}
        </p>
      ) : null}
      <div
        ref={areaRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted"
      >
        <canvas
          ref={canvasRef}
          className={
            showPicture
              ? "block max-h-full max-w-full object-contain"
              : "pointer-events-none hidden"
          }
          aria-label={tx("Screen of {machine}", { machine })}
          data-screen-picture=""
        />
        {showPicture ? null : (
          <div
            className="mx-4 w-full max-w-md rounded-xl border border-border bg-popover p-5 text-center text-popover-foreground shadow-lg"
            role="status"
            aria-live="polite"
            data-screen-message=""
          >
            {endWords && end ? (
              <>
                {warning ? (
                  <ShieldAlertIcon
                    className="mx-auto mb-2 size-5 text-warning-foreground"
                    aria-hidden
                  />
                ) : null}
                <h3 className="text-sm font-semibold">{tx(endWords.title, { machine })}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {tx(endWords.detail, { machine })}
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {end.kind === "machine_key_changed" ? (
                    <Button variant="outline" onClick={onForgetKey}>
                      {tx("Forget saved key and view again")}
                    </Button>
                  ) : null}
                  {screenViewerCanRetry(end) ? (
                    <Button onClick={onRetry}>{tx("View again")}</Button>
                  ) : null}
                  <Button variant="outline" onClick={onClose}>
                    {tx("Close")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                {live && phase.locked ? (
                  <MonitorOffIcon
                    className="mx-auto mb-2 size-5 text-muted-foreground"
                    aria-hidden
                  />
                ) : phase.kind === "needs_code" && !phase.sent ? null : (
                  <Spinner className="mx-auto mb-2 size-4" />
                )}
                <p className="text-sm">
                  {tx(words === "" ? "Waiting for the first picture from {machine}…" : words, {
                    machine,
                  })}
                </p>
                {phase.kind === "needs_code" ? (
                  <CodeForm
                    triesHere={phase.triesHere}
                    wrong={phase.wrong}
                    sent={phase.sent}
                    onTypedCode={onTypedCode}
                  />
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
