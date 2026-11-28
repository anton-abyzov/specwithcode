/**
 * While this device controls another machine (1519): the pointer, wheel and
 * keys over the picture go to that machine, batched a few dozen times a
 * second. Keys go only while the picture area has focus, so typing elsewhere
 * in the app stays here. Leaving the picture area, the window or the view lets
 * go of whatever is held.
 */
import type { ScreenShareInputEvent } from "@specweave-studio/contracts";
import { useEffect, useRef, type RefObject } from "react";

import {
  CONTROL_SEND_MS,
  ControlInput,
  isControlKey,
  pointerButton,
  pointerFraction,
  wheelPixels,
} from "./screenControlInput.logic";

export function useScreenControlInput(input: {
  readonly enabled: boolean;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  /** The element that takes focus, and keys, while controlling. */
  readonly focusRef: RefObject<HTMLElement | null>;
  /** The display shown; input is for it only. */
  readonly displayId: string | null;
  readonly send: (displayId: string, events: ReadonlyArray<ScreenShareInputEvent>) => void;
  /** Whether keys go to the other machine now: the picture area has focus. */
  readonly onKeyboard?: (here: boolean) => void;
}): void {
  const { enabled, canvasRef, focusRef, displayId } = input;
  const sendRef = useRef(input.send);
  sendRef.current = input.send;
  const keyboardRef = useRef(input.onKeyboard);
  keyboardRef.current = input.onKeyboard;

  useEffect(() => {
    const canvas = canvasRef.current;
    const area = focusRef.current;
    if (!enabled || canvas === null || area === null || displayId === null) return;
    const pending = new ControlInput();
    const flush = () => {
      for (let events = pending.take(); events.length > 0; events = pending.take())
        sendRef.current(displayId, events);
    };
    const timer = setInterval(flush, CONTROL_SEND_MS);
    const at = (event: { clientX: number; clientY: number }) =>
      pointerFraction(event.clientX, event.clientY, canvas.getBoundingClientRect());

    const onPointerMove = (event: PointerEvent) => {
      const place = at(event);
      if (place !== null) pending.push({ t: "move", ...place });
    };
    const onPointerDown = (event: PointerEvent) => {
      const button = pointerButton(event.button);
      const place = at(event);
      if (button === null || place === null) return;
      event.preventDefault();
      area.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      pending.push({ t: "button", button, down: true, ...place });
    };
    const onPointerUp = (event: PointerEvent) => {
      const button = pointerButton(event.button);
      const place = at(event);
      if (button === null || place === null) return;
      pending.push({ t: "button", button, down: false, ...place });
    };
    const onWheel = (event: WheelEvent) => {
      const place = at(event);
      if (place === null) return;
      event.preventDefault();
      pending.push({
        t: "scroll",
        dx: wheelPixels(event.deltaX, event.deltaMode),
        dy: wheelPixels(event.deltaY, event.deltaMode),
        ...place,
      });
    };
    const onContextMenu = (event: Event) => event.preventDefault();
    const key = (down: boolean) => (event: KeyboardEvent) => {
      // Control+Option+Escape stays here: it gives the keyboard back to this window.
      if (event.code === "Escape" && event.ctrlKey && event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (down) area.blur();
        return;
      }
      if (!isControlKey(event.code)) return;
      // The key is the other machine's now, not this window's shortcut.
      event.preventDefault();
      event.stopPropagation();
      pending.push({ t: "key", code: event.code, down });
    };
    const onKeyDown = key(true);
    const onKeyUp = key(false);
    const letGo = () => {
      pending.releaseAll();
      flush();
    };
    const onAreaFocus = () => keyboardRef.current?.(true);
    const onAreaBlur = () => {
      letGo();
      keyboardRef.current?.(false);
    };
    const onVisibility = () => {
      if (document.hidden) letGo();
    };

    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", letGo);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    area.addEventListener("keydown", onKeyDown);
    area.addEventListener("keyup", onKeyUp);
    area.addEventListener("focus", onAreaFocus);
    area.addEventListener("blur", onAreaBlur);
    window.addEventListener("blur", letGo);
    document.addEventListener("visibilitychange", onVisibility);
    area.focus({ preventScroll: true });
    return () => {
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", letGo);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      area.removeEventListener("keydown", onKeyDown);
      area.removeEventListener("keyup", onKeyUp);
      area.removeEventListener("focus", onAreaFocus);
      area.removeEventListener("blur", onAreaBlur);
      window.removeEventListener("blur", letGo);
      document.removeEventListener("visibilitychange", onVisibility);
      letGo();
      clearInterval(timer);
      keyboardRef.current?.(false);
    };
  }, [enabled, canvasRef, focusRef, displayId]);
}
