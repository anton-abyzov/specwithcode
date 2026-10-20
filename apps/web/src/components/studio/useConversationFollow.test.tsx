// @vitest-environment jsdom
import { Activity, act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { noteReaderScroll } from "../../lib/readerScroll";
import { FOLLOW_ANCHOR_ATTRIBUTE, useConversationFollow } from "./useConversationFollow";

/**
 * jsdom lays nothing out. Each row is 100px tall in a 300px viewport, and a
 * conversation under `display: none` behaves as in a browser: no box, so it
 * reads as 0 tall and scrolled to the top, and it loses its offset.
 */
const ROW = 100;
const VIEW = 300;
let container: HTMLDivElement;
let root: Root;

function hidden(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement)
    if ((node as HTMLElement).style?.display === "none") return true;
  return false;
}

const emulated = new WeakSet<HTMLElement>();
const tops = new WeakMap<HTMLElement, number>();
const readTop = (scroller: HTMLElement) => {
  if (hidden(scroller)) tops.set(scroller, 0);
  return tops.get(scroller) ?? 0;
};
const anchors = (scroller: HTMLElement) => [
  ...scroller.querySelectorAll(`[${FOLLOW_ANCHOR_ATTRIBUTE}]`),
];

function emulateLayout(scroller: HTMLElement) {
  if (emulated.has(scroller)) return;
  emulated.add(scroller);
  // The hook opened it at its end before it had a layout here.
  tops.set(scroller, Math.max(0, anchors(scroller).length * ROW - VIEW));
  const height = () => (hidden(scroller) ? 0 : anchors(scroller).length * ROW);
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    get: () => (hidden(scroller) ? 0 : VIEW),
  });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: height });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => readTop(scroller),
    set: (value: number) => {
      tops.set(scroller, hidden(scroller) ? 0 : Math.max(0, Math.min(value, height() - VIEW)));
    },
  });
}

const nativeRect = HTMLElement.prototype.getBoundingClientRect;
function rect(this: HTMLElement): DOMRect {
  if (scroller !== null && this === scroller) return { top: 0, bottom: VIEW } as DOMRect;
  if (scroller !== null && this.hasAttribute(FOLLOW_ANCHOR_ATTRIBUTE)) {
    const index = anchors(scroller).indexOf(this);
    const top = index * ROW - readTop(scroller);
    return { top, bottom: top + ROW } as DOMRect;
  }
  return nativeRect.call(this);
}

type View = { readonly away: boolean; readonly unseen: boolean; readonly jumpToLatest: () => void };
let view: View;
let scroller: HTMLDivElement | null = null;

function Conversation({ count, conversationKey }: { count: number; conversationKey: string }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  if (element !== null) scroller = element;
  view = useConversationFollow(element, {
    contentKey: String(count),
    ownSendKey: null,
    resetKey: conversationKey,
  });
  return (
    <div ref={setElement}>
      {Array.from({ length: count }, (_, index) => (
        <p key={index} {...{ [FOLLOW_ANCHOR_ATTRIBUTE]: `m${index}` }} />
      ))}
    </div>
  );
}

async function show(props: {
  count: number;
  conversationKey: string;
  mode?: "visible" | "hidden";
  mounted?: boolean;
}) {
  await act(async () =>
    root.render(
      props.mounted === false ? null : (
        <Activity mode={props.mode ?? "visible"}>
          <Conversation count={props.count} conversationKey={props.conversationKey} />
        </Activity>
      ),
    ),
  );
  if (scroller !== null) emulateLayout(scroller);
}

// The reader scrolls: a wheel, then the scroll it causes.
async function scrollTo(value: number) {
  const deltaY = value - scroller!.scrollTop;
  scroller!.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
  scroller!.scrollTop = value;
  await act(async () => {
    scroller!.dispatchEvent(new Event("scroll"));
    // The place is kept on the next frame.
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

// jsdom has no PointerEvent; the hook reads only its type and button.
function pointer(type: string, pointerType = "mouse"): Event {
  return Object.assign(new MouseEvent(type, { bubbles: true }), { pointerType });
}
function touch(type: string, clientY: number): Event {
  return Object.assign(new Event(type, { bubbles: true }), { touches: [{ clientY }] });
}

// Something other than the reader moves the view: scroll anchoring, a loaded picture.
async function browserScroll(value: number) {
  scroller!.scrollTop = value;
  await act(async () => {
    scroller!.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.getBoundingClientRect = rect;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  HTMLElement.prototype.getBoundingClientRect = nativeRect;
  container.remove();
});

describe("useConversationFollow across a hidden or remounted page", () => {
  it("opens a conversation it has no place for at its end", async () => {
    await show({ count: 10, conversationKey: "first-visit" });
    await scrollTo(scroller!.scrollHeight);
    expect(scroller!.scrollTop).toBe(700);
    expect(view.away).toBe(false);
  });

  it("returns a reader further up to the same message after the page was hidden", async () => {
    await show({ count: 10, conversationKey: "hidden-reading" });
    await scrollTo(250);
    await show({ count: 10, conversationKey: "hidden-reading", mode: "hidden" });
    // Hidden, the conversation has no box and has lost its offset.
    expect(scroller!.scrollTop).toBe(0);
    await show({ count: 10, conversationKey: "hidden-reading" });
    expect(scroller!.scrollTop).toBe(250);
    expect(view.away).toBe(true);
    expect(view.unseen).toBe(false);
  });

  it("marks what arrived while hidden as new and leaves the reader where they were", async () => {
    await show({ count: 10, conversationKey: "hidden-new" });
    await scrollTo(250);
    await show({ count: 10, conversationKey: "hidden-new", mode: "hidden" });
    await show({ count: 12, conversationKey: "hidden-new", mode: "hidden" });
    await show({ count: 12, conversationKey: "hidden-new" });
    expect(scroller!.scrollTop).toBe(250);
    expect(view.unseen).toBe(true);
    // The way down reaches the newest message and follows from there.
    await act(async () => view.jumpToLatest());
    expect(scroller!.scrollTop).toBe(12 * ROW - VIEW);
    await scrollTo(scroller!.scrollTop);
    expect(view.away).toBe(false);
    await show({ count: 13, conversationKey: "hidden-new" });
    expect(scroller!.scrollTop).toBe(13 * ROW - VIEW);
  });

  it("shows a following reader what arrived while the page was hidden", async () => {
    await show({ count: 10, conversationKey: "hidden-following" });
    await scrollTo(700);
    await show({ count: 10, conversationKey: "hidden-following", mode: "hidden" });
    await show({ count: 14, conversationKey: "hidden-following", mode: "hidden" });
    await show({ count: 14, conversationKey: "hidden-following" });
    expect(scroller!.scrollTop).toBe(14 * ROW - VIEW);
    expect(view.away).toBe(false);
  });

  it("ignores scroll events while hidden", async () => {
    await show({ count: 10, conversationKey: "hidden-scroll" });
    await scrollTo(200);
    await show({ count: 10, conversationKey: "hidden-scroll", mode: "hidden" });
    // Hidden, the conversation reads as both its top and its end.
    await act(async () => scroller!.dispatchEvent(new Event("scroll")));
    await show({ count: 10, conversationKey: "hidden-scroll" });
    expect(scroller!.scrollTop).toBe(200);
    expect(view.away).toBe(true);
  });

  it("starts another conversation in the same scroller with nothing marked new", async () => {
    await show({ count: 10, conversationKey: "main" });
    await scrollTo(200);
    await show({ count: 11, conversationKey: "main" });
    expect(view.unseen).toBe(true);
    await show({ count: 4, conversationKey: "snapshot" });
    expect(view.unseen).toBe(false);
    await show({ count: 11, conversationKey: "main" });
    expect(scroller!.scrollTop).toBe(200);
    expect(view.away).toBe(true);
    expect(view.unseen).toBe(false);
  });

  it("returns to the same message after the page unmounted, once its history arrives", async () => {
    await show({ count: 10, conversationKey: "remount" });
    await scrollTo(450);
    await show({ count: 10, conversationKey: "remount", mounted: false });
    // Mounted again before the history came back from the host.
    await show({ count: 0, conversationKey: "remount" });
    await show({ count: 10, conversationKey: "remount" });
    expect(scroller!.scrollTop).toBe(450);
    expect(view.away).toBe(true);
  });
});

describe("useConversationFollow keeps following until the reader scrolls up", () => {
  it("puts a following reader back at the end when the browser scrolls on its own", async () => {
    await show({ count: 10, conversationKey: "browser-scroll" });
    expect(scroller!.scrollTop).toBe(700);
    await browserScroll(540);
    expect(scroller!.scrollTop).toBe(700);
    expect(view.away).toBe(false);
    await show({ count: 12, conversationKey: "browser-scroll" });
    expect(scroller!.scrollTop).toBe(900);
    expect(view.unseen).toBe(false);
  });

  it("keeps following after a click on a message, even with a little jitter", async () => {
    await show({ count: 10, conversationKey: "click" });
    const row = scroller!.querySelector("p")!;
    await act(async () => {
      row.dispatchEvent(pointer("pointerdown"));
      window.dispatchEvent(pointer("pointermove"));
      window.dispatchEvent(pointer("pointerup"));
    });
    await browserScroll(600);
    expect(scroller!.scrollTop).toBe(700);
    expect(view.away).toBe(false);
  });

  it("lets the scrollbar leave the end from the press, with no move reaching the page", async () => {
    await show({ count: 10, conversationKey: "scrollbar" });
    scroller!.dispatchEvent(pointer("pointerdown"));
    await browserScroll(400);
    expect(scroller!.scrollTop).toBe(400);
    expect(view.away).toBe(true);
    window.dispatchEvent(pointer("pointerup"));
  });

  it("lets a finger flick leave the end after the browser cancels its pointer", async () => {
    await show({ count: 10, conversationKey: "flick" });
    scroller!.dispatchEvent(touch("touchstart", 100));
    scroller!.dispatchEvent(pointer("pointercancel", "touch"));
    scroller!.dispatchEvent(touch("touchmove", 160));
    window.dispatchEvent(touch("touchend", 160));
    await browserScroll(300);
    expect(scroller!.scrollTop).toBe(300);
    expect(view.away).toBe(true);
  });

  it("keeps following when a finger moves up from the end", async () => {
    await show({ count: 10, conversationKey: "finger-up" });
    scroller!.dispatchEvent(touch("touchstart", 160));
    scroller!.dispatchEvent(touch("touchmove", 100));
    await browserScroll(650);
    expect(scroller!.scrollTop).toBe(700);
    window.dispatchEvent(touch("touchend", 100));
  });

  it("lets an upward key leave the end", async () => {
    await show({ count: 10, conversationKey: "key" });
    scroller!.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    await browserScroll(400);
    expect(scroller!.scrollTop).toBe(400);
    expect(view.away).toBe(true);
  });

  it("lets a find jump leave the end", async () => {
    await show({ count: 10, conversationKey: "find" });
    noteReaderScroll(scroller!);
    await browserScroll(300);
    expect(scroller!.scrollTop).toBe(300);
    expect(view.away).toBe(true);
  });

  it("follows again once the reader scrolls back to the end, with no click", async () => {
    await show({ count: 10, conversationKey: "scroll-back" });
    await scrollTo(250);
    expect(view.away).toBe(true);
    await show({ count: 11, conversationKey: "scroll-back" });
    expect(scroller!.scrollTop).toBe(250);
    expect(view.unseen).toBe(true);
    await scrollTo(scroller!.scrollHeight);
    expect(view.away).toBe(false);
    expect(view.unseen).toBe(false);
    await show({ count: 13, conversationKey: "scroll-back" });
    expect(scroller!.scrollTop).toBe(13 * ROW - VIEW);
  });

  it("stays where the reader is when the browser scrolls while they read", async () => {
    await show({ count: 10, conversationKey: "reading-browser-scroll" });
    await scrollTo(250);
    await browserScroll(240);
    expect(scroller!.scrollTop).toBe(240);
    expect(view.away).toBe(true);
  });
});
