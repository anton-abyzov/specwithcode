/** Bring back opens the same one-thread hand off a move by hand uses (1390 AC-23). */
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const handOff = vi.hoisted(() => vi.fn());
vi.mock("./HandOffThreadDialog", () => ({ requestHandOffThread: handOff }));
vi.mock("../ui/button", () => ({ Button: "button" }));

import { act, create } from "react-test-renderer";
import { BringBackButton } from "./BringBack";

const offer = {
  threadRef: { environmentId: "env-m5" as EnvironmentId, threadId: "thread-on-m5" as ThreadId },
  destinationEnvironmentId: "env-m4" as EnvironmentId,
  machine: "M4",
  refused: null,
};

describe("BringBackButton", () => {
  it("opens the hand off of that one thread to the source machine", () => {
    const renderer = create(<BringBackButton offer={offer} />);
    act(() => renderer.root.findByType("button").props.onClick());
    expect(handOff).toHaveBeenCalledWith(offer.threadRef, {
      destinationEnvironmentId: "env-m4",
    });
    act(() => renderer.unmount());
  });

  it("says why when it is refused, and does nothing", () => {
    handOff.mockReset();
    const refused = { ...offer, refused: "Answer its question or approval first." };
    const html = renderToStaticMarkup(<BringBackButton offer={refused} />);
    expect(html).toContain("Bring back to M4");
    expect(html).toContain('title="Answer its question or approval first."');
    expect(html).toContain("disabled");
    const renderer = create(<BringBackButton offer={refused} />);
    expect(renderer.root.findByType("button").props.disabled).toBe(true);
    act(() => renderer.unmount());
  });

  it("renders nothing without an offer", () => {
    expect(renderToStaticMarkup(<BringBackButton offer={null} />)).toBe("");
  });
});
