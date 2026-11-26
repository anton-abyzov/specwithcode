/**
 * The sign-in viewer's rules (1488), apart from React so tests cover them:
 * which keys go as named keys, where a click lands on the remote page, and
 * how typed characters are batched, sealed and sent in order.
 */
import { sealForSignIn } from "@specweave-studio/shared/signInSeal";

/** Keys sent by name; the server refuses any other key. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Escape: "escape",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

export type SignInKeyAction =
  | { readonly kind: "named"; readonly key: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ignore" };

/** What a key press in the view does. Shortcuts with Ctrl, Cmd or Alt stay with this window. */
export function signInKeyAction(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}): SignInKeyAction {
  if (event.isComposing === true || event.ctrlKey || event.metaKey) return { kind: "ignore" };
  const named = NAMED_KEYS[event.key];
  if (named !== undefined) return event.altKey ? { kind: "ignore" } : { kind: "named", key: named };
  // One character (an emoji is two UTF-16 units): Alt may make it, as on a Mac keyboard.
  if ([...event.key].length === 1) return { kind: "text", text: event.key };
  return { kind: "ignore" };
}

/** A point on the shown image, in the remote page's CSS pixels. */
export function framePoint(
  client: { readonly x: number; readonly y: number },
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  frame: { readonly width: number; readonly height: number },
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = ((client.x - rect.left) / rect.width) * frame.width;
  const y = ((client.y - rect.top) / rect.height) * frame.height;
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/** The most characters one sealed message carries; the server takes up to 1,000. */
export const SIGN_IN_TEXT_CHUNK = 500;

export interface SignInSender {
  /** A named key, sent after any text typed before it. */
  readonly key: (frame: string, key: string) => void;
  /** Characters; batched briefly so a fast typist sends few messages. */
  readonly text: (frame: string, text: string) => void;
  /** Anything that must go after what was typed: a click or a scroll. */
  readonly other: (send: () => Promise<void>) => void;
  /** Sends what is buffered now. */
  readonly flush: () => void;
  /** Drops what is buffered without sending; the view is closing. */
  readonly drop: () => void;
  /** Resolves once everything queued so far has been sent or has failed. */
  readonly settled: () => Promise<void>;
}

/**
 * One ordered queue for everything the person does. Text is sealed to the
 * view's key with a seq that only grows; nothing typed is kept once sent.
 */
export function createSignInSender(options: {
  readonly publicKey: string;
  readonly sendText: (sealed: string) => Promise<void>;
  readonly sendKey: (frame: string, key: string) => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly batchMs?: number;
  readonly schedule?: (run: () => void, ms: number) => () => void;
}): SignInSender {
  const batchMs = options.batchMs ?? 120;
  const schedule =
    options.schedule ??
    ((run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  let seq = 0;
  let queue: Promise<void> = Promise.resolve();
  let pending: { frame: string; text: string } | null = null;
  let cancelTimer: (() => void) | null = null;
  let dropped = false;

  const enqueue = (send: () => Promise<void>) => {
    queue = queue.then(() => (dropped ? undefined : send())).catch(options.onError);
  };
  const flush = () => {
    cancelTimer?.();
    cancelTimer = null;
    const batch = pending;
    pending = null;
    if (!batch || batch.text.length === 0) return;
    const chars = [...batch.text];
    for (let at = 0; at < chars.length; at += SIGN_IN_TEXT_CHUNK) {
      const text = chars.slice(at, at + SIGN_IN_TEXT_CHUNK).join("");
      seq += 1;
      const payload = JSON.stringify({ seq, frame: batch.frame, text });
      enqueue(async () =>
        options.sendText(await sealForSignIn(new TextEncoder().encode(payload), options.publicKey)),
      );
    }
  };
  return {
    key: (frame, key) => {
      flush();
      enqueue(() => options.sendKey(frame, key));
    },
    text: (frame, text) => {
      if (pending && pending.frame !== frame) flush();
      pending = { frame, text: (pending?.text ?? "") + text };
      cancelTimer?.();
      cancelTimer = schedule(flush, batchMs);
    },
    other: (send) => {
      flush();
      enqueue(send);
    },
    flush,
    drop: () => {
      dropped = true;
      cancelTimer?.();
      pending = null;
    },
    settled: () => queue,
  };
}
