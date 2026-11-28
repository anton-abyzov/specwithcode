/**
 * Turning pointer, wheel and key events in a viewer into the input a
 * controlled machine reads (1519). No DOM in here: the hook hands in numbers.
 *
 * Pointer places are fractions of the picture, so they mean the same on the
 * machine whatever size the picture is drawn here. Moves between two sends
 * are folded into the last one. Whatever is held here is let go when this
 * device stops controlling, loses focus or hides the view.
 */
import {
  SCREEN_SHARE_INPUT_MAX_EVENTS,
  SCREEN_SHARE_KEY_CODES,
  type ScreenShareInputEvent,
} from "@specweave-studio/contracts";

/** How often batched input is sent while controlling. */
export const CONTROL_SEND_MS = 33;
const EDGE = 0.05;
const SCROLL_MAX = 10_000;

export interface PictureRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Where on the picture a pointer is, as fractions; null when the picture has no size. */
export const pointerFraction = (
  clientX: number,
  clientY: number,
  rect: PictureRect,
): { readonly x: number; readonly y: number } | null => {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    x: clamp((clientX - rect.left) / rect.width, -EDGE, 1 + EDGE),
    y: clamp((clientY - rect.top) / rect.height, -EDGE, 1 + EDGE),
  };
};

export const pointerButton = (button: number): "left" | "middle" | "right" | null =>
  button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : null;

/** A wheel's delta in pixels, whatever unit the browser gave it in. */
export const wheelPixels = (delta: number, deltaMode: number): number => {
  const pixels = deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * 800 : delta;
  return Number.isFinite(pixels) ? clamp(Math.round(pixels), -SCROLL_MAX, SCROLL_MAX) : 0;
};

export const isControlKey = (code: string): boolean => SCREEN_SHARE_KEY_CODES.has(code);

/** Input waiting to be sent, and what is held down. */
export class ControlInput {
  private queue: Array<ScreenShareInputEvent> = [];
  private readonly keys = new Set<string>();
  private readonly buttons = new Set<"left" | "middle" | "right">();
  private last = { x: 0.5, y: 0.5 };

  push(event: ScreenShareInputEvent): void {
    if (event.t === "key") {
      if (!isControlKey(event.code)) return;
      // A key let go that was never pressed here is not sent.
      if (!event.down && !this.keys.has(event.code)) return;
      if (event.down) this.keys.add(event.code);
      else this.keys.delete(event.code);
    } else {
      this.last = { x: event.x, y: event.y };
      if (event.t === "button") {
        if (!event.down && !this.buttons.has(event.button)) return;
        if (event.down) this.buttons.add(event.button);
        else this.buttons.delete(event.button);
      }
      if (event.t === "move" && this.queue.at(-1)?.t === "move") {
        this.queue[this.queue.length - 1] = event;
        return;
      }
    }
    this.queue.push(event);
  }

  /** Lets go of everything held here: queued as key and button ups. */
  releaseAll(): void {
    for (const code of [...this.keys]) this.push({ t: "key", code, down: false });
    for (const button of [...this.buttons])
      this.push({ t: "button", button, down: false, ...this.last });
  }

  get held(): boolean {
    return this.keys.size > 0 || this.buttons.size > 0;
  }

  /** The next record's events, oldest first; the rest wait for the next send. */
  take(): Array<ScreenShareInputEvent> {
    const events = this.queue.slice(0, SCREEN_SHARE_INPUT_MAX_EVENTS);
    this.queue = this.queue.slice(SCREEN_SHARE_INPUT_MAX_EVENTS);
    return events;
  }
}
