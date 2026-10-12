import { describe, expect, it } from "vite-plus/test";
import { THREAD_LIFECYCLE_LABELS } from "./threadLifecycleLabels.ts";
describe("lifecycle presentation", () => {
  it("uses deliberate completion and a reversible action consistently", () => {
    expect([
      THREAD_LIFECYCLE_LABELS.resolve,
      THREAD_LIFECYCLE_LABELS.resolved,
      THREAD_LIFECYCLE_LABELS.reopen,
    ]).toEqual(["Resolve", "Resolved", "Reopen"]);
    expect(THREAD_LIFECYCLE_LABELS.shortcut).toBe("Thread: Resolve / Reopen");
    expect(Object.values(THREAD_LIFECYCLE_LABELS).join(" ")).not.toMatch(/settle/i);
  });
});
