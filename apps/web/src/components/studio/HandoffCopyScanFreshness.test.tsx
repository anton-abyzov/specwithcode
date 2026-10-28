// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { HandoffCopyScanFreshness, measuredAgo } from "./HandoffCopyScanFreshness";
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
    expect(container.textContent).toBe("Measured earlier·Measure again");
    await act(async () => container.querySelector("button")!.click());
    expect(refresh).toHaveBeenCalledOnce();
    expect(compare).not.toHaveBeenCalled();
    await render({
      scanCompletedAt: 1793061000000,
      freshness: { checkedAt: 1793062000000, current: true },
    });
    expect(container.querySelector('[data-slot="copy-scan-age"]')?.textContent).toMatch(
      /^Measured (?!earlier)\S/,
    );
    expect(container.textContent).not.toMatch(/scan|worktree/i);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Nothing changed since then, so your choices stay.",
    );
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await render({ freshness: { checkedAt: 1793062000000, current: false } });
    expect(container.textContent).toContain("Compare again before copying.");
    expect(compare).not.toHaveBeenCalled();
    await act(async () => container.querySelectorAll("button")[1]!.click());
    expect(compare).toHaveBeenCalledOnce();
    expect(measuredAgo(1000, 1000 + 2 * 86_400_000)).toBe("2 days ago");
    expect(measuredAgo(1000, 1000 + 30_000)).toBe("just now");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
