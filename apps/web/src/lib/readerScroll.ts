/**
 * When the reader last asked a scroller to move up: a wheel or key, or a
 * feature acting for them (find jumping to a match). A conversation that
 * follows its end reads this to tell their scrolling from the browser's.
 */
const asked = new WeakMap<Element, number>();

export function noteReaderScroll(scroller: Element): void {
  asked.set(scroller, performance.now());
}

export function readerScrollAskedAt(scroller: Element): number {
  return asked.get(scroller) ?? Number.NEGATIVE_INFINITY;
}

/** Notes every scroller around `element`, before a feature scrolls it into view for the reader. */
export function noteReaderScrollAround(element: Element): void {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight) noteReaderScroll(node);
  }
}
