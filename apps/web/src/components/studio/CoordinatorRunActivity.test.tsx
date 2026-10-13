// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { CoordinatorRunActivity } from "./CoordinatorRunActivity";

it("opens full coordinator output in project details", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const open = vi.fn();
  try {
    await act(async () =>
      root.render(
        <CoordinatorRunActivity
          activity={{
            runId: "r",
            summary: "Read 1 file",
            steps: [{ id: "s", label: "Read README", failed: false }],
          }}
          onOpenCoordinatorPage={open}
        />,
      ),
    );
    expect(container.textContent).toContain("Full output is in coordinator details.");
    await act(async () => container.querySelector("button")!.click());
    expect(open).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
