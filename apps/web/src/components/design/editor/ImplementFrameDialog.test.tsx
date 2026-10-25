// @vitest-environment jsdom
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ImplementFrameDialog } from "./ImplementFrameDialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const existing = {
  binding: { environmentId: "env-a" as EnvironmentId, threadId: "t-1" as ThreadId },
  title: "Build the booking page",
};

function render(providerReady: boolean | undefined) {
  const onSend = vi.fn(async () => undefined);
  act(() =>
    root.render(
      <ImplementFrameDialog
        open
        onOpenChange={() => undefined}
        frameName="Booking"
        threads={[existing]}
        canStartNew
        {...(providerReady === undefined ? {} : { providerReady })}
        onSend={onSend}
      />,
    ),
  );
  return onSend;
}

const text = () =>
  document.body.querySelector('[data-testid="implement-frame-dialog"]')?.textContent ?? "";
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
const option = (title: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((candidate) =>
    candidate.textContent?.startsWith(title),
  );

describe("ImplementFrameDialog", () => {
  it("sends the frame when a provider is ready", () => {
    render(undefined);
    expect(text()).toContain("Sends the frame as JSON with a PNG");
    expect(text()).toContain("Starts in this design's project with its worker model");
    expect(button("Send frame")).toBeDefined();
  });

  it("creates a thread that holds the frame when no provider is ready", async () => {
    const onSend = render(false);
    expect(text()).toContain("No provider is ready, so a new thread holds it for you to send.");
    expect(text()).toContain("Nothing runs until you press Send.");
    await act(async () => button("Create thread")?.click());
    expect(onSend).toHaveBeenCalledExactlyOnceWith({ kind: "new" });

    // An existing thread still gets the frame now.
    act(() => option("Build the booking page")?.click());
    expect(button("Send frame")).toBeDefined();
    expect(button("Create thread")).toBeUndefined();
  });
});
