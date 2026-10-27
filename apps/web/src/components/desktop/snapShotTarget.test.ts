import { describe, expect, it } from "vite-plus/test";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  resolveProjectSnapShotTarget,
  sameSnapShotTarget,
  snapShotReturnHref,
} from "./snapShotTarget";

const group = {
  memberProjects: [
    { environmentId: "mac", id: "local", workspaceSettings: {} },
    { environmentId: "peer", id: "remote", workspaceSettings: {} },
  ],
} as unknown as SidebarProjectSnapshot;
const base = { group, primaryEnvironmentId: "mac" };

describe("snapshot project conversation", () => {
  it("keeps the project pane's exact thread machine instead of the checkout's machine", () => {
    expect(
      resolveProjectSnapShotTarget({
        ...base,
        search: {
          checkout: "mac:local",
          thread: "worker" as never,
          threadEnvironment: "peer",
        },
      }),
    ).toEqual({ environmentId: "peer", threadId: "worker" });
  });
  it("uses the explicit checkout when the pane has no machine override", () => {
    expect(
      resolveProjectSnapShotTarget({
        ...base,
        search: {
          checkout: "peer:remote",
          thread: "worker" as never,
        },
      }),
    ).toEqual({ environmentId: "peer", threadId: "worker" });
  });
  it("keeps the viewed project coordinator instead of creating Scratch", () => {
    expect(
      resolveProjectSnapShotTarget({ ...base, lastViewed: "peer:remote", search: {} }),
    ).toEqual({ kind: "coordinator", projectRef: { environmentId: "peer", projectId: "remote" } });
  });
  it("does not substitute another project when the explicit checkout is unavailable", () => {
    expect(
      resolveProjectSnapShotTarget({ ...base, search: { checkout: "missing:project" } }),
    ).toBeNull();
  });
  it("refuses an unbound thread environment", () => {
    expect(
      resolveProjectSnapShotTarget({
        ...base,
        search: {
          thread: "worker" as never,
          threadEnvironment: "unbound",
        },
      }),
    ).toBeNull();
  });
  it("does not equate the same thread id on two machines", () => {
    expect(
      sameSnapShotTarget(
        { environmentId: "mac", threadId: "same" } as never,
        { environmentId: "peer", threadId: "same" } as never,
      ),
    ).toBe(false);
  });
});

describe("snapshot return from Settings", () => {
  const prior = "/projects/repo?checkout=peer%3Aremote&thread=worker&threadEnvironment=peer";
  it("returns to the complete original project URL after acquisition", () => {
    expect(snapShotReturnHref("/settings/snap-shot", "/settings/snap-shot", prior)).toBe(prior);
  });
  it("does not replace a newer user navigation or Settings section change", () => {
    expect(snapShotReturnHref("/settings/snap-shot", "/projects/other", prior)).toBeNull();
    expect(snapShotReturnHref("/settings/snap-shot", "/settings/providers", prior)).toBeNull();
  });
  it("does not navigate an ordinary capture or fabricate a missing return URL", () => {
    expect(snapShotReturnHref(prior, prior, prior)).toBeNull();
    expect(snapShotReturnHref("/settings/snap-shot", "/settings/snap-shot", null)).toBeNull();
  });
});
