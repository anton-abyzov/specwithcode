import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@specweave-studio/contracts";

import {
  accountInGrant,
  checkIncomingDelegation,
  coordinatorOfWorkerLabel,
  delegationRefusal,
  outgoingDelegation,
  projectInGrant,
  WORKER_CLIENT_LABEL_PREFIX,
} from "./workGrantPolicy.ts";
import { workerClientName } from "./workerGrantMint.ts";

const M4 = EnvironmentId.make("env-m4");
const M3 = EnvironmentId.make("env-m3");
const M1 = EnvironmentId.make("env-m1");
const labels = new Map([
  [M4 as string, "M4MAX"],
  [M3 as string, "M3"],
  [M1 as string, "M1"],
]);

describe("work grant policy", () => {
  it("reads the coordinator from a worker grant's label and from nothing else", () => {
    expect(workerClientName(M4).startsWith(WORKER_CLIENT_LABEL_PREFIX)).toBe(true);
    expect(coordinatorOfWorkerLabel(workerClientName(M4))).toBe(M4);
    expect(coordinatorOfWorkerLabel("Claude Desktop")).toBeUndefined();
    expect(coordinatorOfWorkerLabel(WORKER_CLIENT_LABEL_PREFIX)).toBeUndefined();
    expect(coordinatorOfWorkerLabel(undefined)).toBeUndefined();
  });

  it("treats a launch from a sender too old to send a path as one hop from it", () => {
    const checked = checkIncomingDelegation({
      ownEnvironmentId: M3,
      coordinatorEnvironmentId: M4,
      delegation: undefined,
      hopLimit: 1,
    });
    expect(checked).toEqual({
      ok: true,
      origin: { coordinatorEnvironmentId: M4, path: [M4], hops: 1 },
    });
  });

  it("refuses a launch whose path already names this machine, naming the path", () => {
    // M4 started work on M3; a thread there tries to start work back on M4.
    const checked = checkIncomingDelegation({
      ownEnvironmentId: M4,
      coordinatorEnvironmentId: M3,
      delegation: { path: [M4, M3], hops: 2 },
      hopLimit: 2,
    });
    expect(checked).toMatchObject({ ok: false, code: "delegation_cycle", path: [M4, M3] });
    if (checked.ok) return;
    expect(delegationRefusal(checked, labels, M4)).toContain("M4MAX → M3 → M4MAX");
  });

  it("refuses more hops than the grant allows: two for own machines, one for another person's", () => {
    const twoHops = { path: [M4, M3], hops: 2 };
    expect(
      checkIncomingDelegation({
        ownEnvironmentId: M1,
        coordinatorEnvironmentId: M3,
        delegation: twoHops,
        hopLimit: 2,
      }).ok,
    ).toBe(true);
    const refused = checkIncomingDelegation({
      ownEnvironmentId: M1,
      coordinatorEnvironmentId: M3,
      delegation: twoHops,
      hopLimit: 1,
    });
    expect(refused).toMatchObject({ ok: false, code: "delegation_limit", hops: 2, limit: 1 });
    if (refused.ok) return;
    expect(delegationRefusal(refused, labels, M1)).toContain("M4MAX → M3 → M1");
  });

  it("ends the path with the machine whose grant sent it, whatever the sender claims", () => {
    const checked = checkIncomingDelegation({
      ownEnvironmentId: M1,
      coordinatorEnvironmentId: M3,
      delegation: { path: [M4], hops: 1 },
      hopLimit: 2,
    });
    expect(checked).toEqual({
      ok: true,
      origin: { coordinatorEnvironmentId: M3, path: [M4, M3], hops: 2 },
    });
  });

  it("carries a thread's origin on and refuses a loop before it is sent", () => {
    expect(
      outgoingDelegation({ localEnvironmentId: M4, targetEnvironmentId: M3, origin: undefined }),
    ).toEqual({ ok: true, delegation: { path: [M4], hops: 1 } });
    const origin = { coordinatorEnvironmentId: M4, path: [M4], hops: 1 };
    expect(outgoingDelegation({ localEnvironmentId: M3, targetEnvironmentId: M1, origin })).toEqual(
      { ok: true, delegation: { path: [M4, M3], hops: 2 } },
    );
    const loop = outgoingDelegation({ localEnvironmentId: M3, targetEnvironmentId: M4, origin });
    expect(loop).toMatchObject({ ok: false, code: "delegation_cycle", path: [M4, M3, M4] });
  });

  it("keeps different projects coordinating on each other's machines allowed", () => {
    // M3's own thread (no origin) starting work on M4 is not a cycle, even though M4 uses M3.
    expect(
      outgoingDelegation({ localEnvironmentId: M3, targetEnvironmentId: M4, origin: undefined }).ok,
    ).toBe(true);
  });

  it("scopes projects to all, linked to the coordinator, or listed", () => {
    const linked = {
      id: "p1",
      workspaceSettings: { logicalProject: { members: [{ environmentId: M4 }] } },
    };
    const unlinked = { id: "p2", workspaceSettings: { logicalProject: null } };
    expect(projectInGrant({ kind: "all" }, M4, unlinked)).toBe(true);
    expect(projectInGrant({ kind: "linked" }, M4, linked)).toBe(true);
    expect(projectInGrant({ kind: "linked" }, M3, linked)).toBe(false);
    expect(projectInGrant({ kind: "linked" }, M4, unlinked)).toBe(false);
    expect(projectInGrant({ kind: "listed", projectIds: ["p2" as never] }, M4, unlinked)).toBe(
      true,
    );
    expect(projectInGrant({ kind: "listed", projectIds: [] }, M4, linked)).toBe(false);
  });

  it("allows all sign-ins, the listed ones, or none", () => {
    const codex = ProviderInstanceId.make("codex");
    expect(accountInGrant({ kind: "all" }, codex)).toBe(true);
    expect(accountInGrant({ kind: "none" }, codex)).toBe(false);
    expect(accountInGrant({ kind: "listed", instanceIds: [codex] }, codex)).toBe(true);
    expect(
      accountInGrant({ kind: "listed", instanceIds: [ProviderInstanceId.make("claude")] }, codex),
    ).toBe(false);
  });
});
