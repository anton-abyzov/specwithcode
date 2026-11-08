import { describe, expect, it } from "vite-plus/test";

import {
  THREAD_ROUTE_GRACE_MS,
  THREAD_ROUTE_SLOW_MS,
  threadRouteProblem,
} from "./threadRouteProblem";

const base = {
  state: "loading" as const,
  deleted: false,
  host: "host-loading" as const,
  machine: "ministorm",
  waitedMs: 0,
};

describe("threadRouteProblem", () => {
  it("names the machine when it is offline, whatever the thread list says", () => {
    for (const state of ["loading", "missing"] as const) {
      const problem = threadRouteProblem({ ...base, state, host: "host-offline" });
      expect(problem.kind).toBe("unreachable");
      expect(problem.detail).toContain("ministorm is offline");
    }
  });
  it("waits for a machine this device has not listed yet, then says it is not connected", () => {
    expect(threadRouteProblem({ ...base, host: "host-unknown" }).kind).toBe("opening");
    const late = threadRouteProblem({
      ...base,
      state: "missing",
      host: "host-unknown",
      waitedMs: THREAD_ROUTE_SLOW_MS,
    });
    expect(late.kind).toBe("unreachable");
    expect(late.detail).toContain("not connected");
  });
  it("says when this device cannot connect", () => {
    expect(threadRouteProblem({ ...base, host: "host-refused" }).detail).toContain(
      "Settings > Machines",
    );
  });
  it("says a thread was deleted", () => {
    expect(threadRouteProblem({ ...base, state: "missing", deleted: true }).kind).toBe("deleted");
  });
  it("waits a moment before calling a thread missing, for one started just now", () => {
    const missing = { ...base, state: "missing" as const, host: "not-registered" as const };
    expect(threadRouteProblem(missing).kind).toBe("opening");
    const found = threadRouteProblem({ ...missing, waitedMs: THREAD_ROUTE_GRACE_MS });
    expect(found.kind).toBe("missing");
    expect(found.detail).toContain("ministorm has no such thread");
  });
  it("never calls a thread missing while its machine has not answered", () => {
    const missing = { ...base, state: "missing" as const };
    expect(threadRouteProblem({ ...missing, waitedMs: THREAD_ROUTE_GRACE_MS }).kind).toBe(
      "opening",
    );
  });
  it("reports a machine that stays silent instead of waiting forever", () => {
    const slow = threadRouteProblem({ ...base, waitedMs: THREAD_ROUTE_SLOW_MS });
    expect(slow.kind).toBe("slow");
    expect(slow.detail).toContain("ministorm has not answered");
  });
});
