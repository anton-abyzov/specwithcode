// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { HandoffCopyScanFreshness } from "./HandoffCopyScanFreshness";
import type { FolderCopySourceStatus } from "@specweave-studio/contracts";

it("labels historical age, checks without replacement and offers explicit recompare only when changed", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const refresh = vi.fn();
  const compare = vi.fn();
  const render = (status: Partial<FolderCopySourceStatus> | null) =>
    act(async () =>
      root.render(
        <HandoffCopyScanFreshness
          status={status as FolderCopySourceStatus | null}
          busy={false}
          onRefresh={refresh}
          onCompareAgain={compare}
        />,
      ),
    );
  try {
    await render(null);
    expect(container.textContent).toContain("measurement time is unknown");
    await act(async () => container.querySelector("button")!.click());
    expect(refresh).toHaveBeenCalledOnce();
    expect(compare).not.toHaveBeenCalled();
    await render({
      scanCompletedAt: 1793061000000,
      freshness: { checkedAt: 1793062000000, current: true },
    });
    expect(container.textContent).toContain("Saved scan from");
    expect(container.textContent).toContain("Your copy choices are unchanged");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await render({ freshness: { checkedAt: 1793062000000, current: false } });
    expect(container.textContent).toContain("Review a new comparison");
    expect(compare).not.toHaveBeenCalled();
    await act(async () => container.querySelectorAll("button")[1]!.click());
    expect(compare).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
