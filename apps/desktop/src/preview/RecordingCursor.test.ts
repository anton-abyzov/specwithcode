import type { DesktopPreviewRecordingInput } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { installRecordingCursor } from "./RecordingCursor.ts";

/** Just enough of a guest's window and document for the recording overlay. */
const makeGuest = () => {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const element = () => ({
    style: { cssText: "", display: "", transform: "", opacity: "", setProperty: () => {} },
    setAttribute: () => {},
    innerHTML: "",
    textContent: "",
    remove: () => {},
  });
  const document = {
    createElement: element,
    documentElement: { append: () => {} },
    activeElement: null,
  } as unknown as Document;
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    navigator: { platform: "MacIntel" },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: () => {},
    requestAnimationFrame: (callback: () => void) => {
      callback();
      return 1;
    },
    cancelAnimationFrame: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  } as unknown as Window;
  const dispatch = (type: string, event: Record<string, unknown>) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return { document, window, dispatch };
};

const pointer = (isTrusted: boolean, x = 10, y = 20) => ({
  isTrusted,
  pointerType: "mouse",
  clientX: x,
  clientY: y,
  relatedTarget: null,
});

const key = (isTrusted: boolean) => ({
  isTrusted,
  key: "k",
  code: "KeyK",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  repeat: false,
});

describe("installRecordingCursor", () => {
  const options = { showKeyPresses: true, showMousePresses: true };

  it("records only the person's own keys and clicks", () => {
    const guest = makeGuest();
    const emitted: Array<DesktopPreviewRecordingInput> = [];
    installRecordingCursor(guest.document, guest.window, options, (input) => emitted.push(input));

    // A page script's synthetic input must not show in the recording.
    guest.dispatch("pointerdown", pointer(false));
    guest.dispatch("pointermove", pointer(false, 30, 40));
    guest.dispatch("pointerup", pointer(false));
    guest.dispatch("keydown", key(false));
    guest.dispatch("keyup", key(false));
    guest.dispatch("pointerout", pointer(false));
    expect(emitted).toEqual([]);

    // The person's own input still does.
    guest.dispatch("pointerdown", pointer(true));
    guest.dispatch("pointerup", pointer(true));
    guest.dispatch("keydown", key(true));
    guest.dispatch("keyup", key(true));
    expect(
      emitted.map(
        (input) =>
          `${input.type}:${input.type === "pointer" ? input.phase : input.type === "key" ? input.held : ""}`,
      ),
    ).toEqual(["pointer:down", "pointer:up", "key:true", "key:false"]);
  });
});
