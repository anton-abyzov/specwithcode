import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadStatusPill } from "../components/Sidebar.logic";
import { approvalWaitLabel, isAccessWait } from "./accessWait";

const withRequest = (request: unknown) =>
  ({ source: { pendingRuntimeRequest: request } }) as unknown as Pick<
    EnvironmentThreadShell,
    "source"
  >;

describe("isAccessWait", () => {
  it("reads the access block, or the access request id when the block is missing", () => {
    const access = { accessTitle: "Use Notes", reason: "", subjects: [] };
    expect(isAccessWait(withRequest({ id: "x", kind: "permission", access }))).toBe(true);
    expect(
      isAccessWait(withRequest({ id: "turn-item:access-request:t:k", kind: "permission" })),
    ).toBe(true);
    expect(isAccessWait(withRequest({ id: "approval:1", kind: "permission" }))).toBe(false);
    expect(
      isAccessWait(withRequest({ id: "turn-item:access-request:t:k", kind: "auth_refresh" })),
    ).toBe(false);
    expect(isAccessWait(withRequest(null))).toBe(false);
    expect(isAccessWait({ source: undefined } as never)).toBe(false);
  });

  it("names the wait", () => {
    expect(
      approvalWaitLabel(withRequest({ id: "turn-item:access-request:t:k", kind: "permission" })),
    ).toBe("Access requested");
    expect(approvalWaitLabel(withRequest(null))).toBe("Approval requested");
  });
});

describe("resolveThreadStatusPill", () => {
  it("names a pending access request apart from a command approval", () => {
    const base = {
      hasActionableProposedPlan: false,
      hasPendingApprovals: true,
      hasPendingUserInput: false,
      interactionMode: "default",
      latestRun: null,
      runtime: null,
    } as never;
    const access = { id: "turn-item:access-request:t:k", kind: "permission" };
    expect(
      resolveThreadStatusPill({
        thread: { ...(base as object), source: { pendingRuntimeRequest: access } } as never,
      })?.label,
    ).toBe("Pending Access");
    expect(resolveThreadStatusPill({ thread: base })?.label).toBe("Pending Approval");
  });
});
