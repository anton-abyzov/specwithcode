import { describe, expect, it, vi } from "vite-plus/test";
import { mayLeave, runUnlink, unlinkGuard, type UnlinkRun } from "./useUnlinkMember";

vi.mock("@specweave-studio/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@specweave-studio/client-runtime/state/runtime")>()),
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  squashAtomCommandFailure: (failure: { error: Error }) => failure.error,
}));
// The hook's machine labels and commands are not used by the pure functions under test.
vi.mock("./useLinkMachines", () => ({ useLinkMachines: () => ({}) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => async () => ({}) }));

const ref = (environmentId: string, projectId: string) => ({
  environmentId,
  projectId,
  coordinatorThreadId: `project-coordinator:${projectId}`,
});
const identity = (members: ReturnType<typeof ref>[]) => ({
  id: "logical:1",
  title: "EasyChamp",
  coordinatorId: "coordinator:logical:1",
  members,
});
const roster = identity([ref("m4", "main"), ref("m5", "side"), ref("m1", "plain")]);
const copy = (
  environmentId: string,
  id: string,
  binding?: Record<string, unknown>,
  logicalProject: ReturnType<typeof identity> = roster,
) =>
  ({
    environmentId,
    id,
    title: "EasyChamp",
    workspaceRoot: `/${environmentId}/EasyChamp`,
    workspaceSettings: {
      kind: "code",
      logicalProject,
      ...(binding ? { coordinatorBinding: { epoch: 0, ...binding } } : {}),
    },
  }) as never;

const main = copy("m4", "main", { state: "active" });
// A coordinator started beside main: active, a later epoch, no predecessor.
const side = copy("m5", "side", { state: "active", epoch: 2, operationId: "op-start" });
const plain = copy("m1", "plain", { state: "transferred", successor: ref("m4", "main") });

const MACHINES: Record<string, string> = { m4: "M4", m5: "M5", m1: "M1" };
const OPERATION = "7307ab55-fc59-4e07-abeb-de54be69215f";

type Call = { tag: string; environmentId: string; input: Record<string, any> };
const fakes = (
  overrides: {
    keptReady?: boolean;
    /** Machines this window cannot write to now. */
    offline?: string[];
    fail?: (call: Call) => unknown;
  } = {},
) => {
  const calls: Call[] = [];
  const store = new Map<string, string>();
  const respond = (tag: string) => async (request: { environmentId: string; input: unknown }) => {
    const call = { tag, ...request } as Call;
    calls.push(call);
    const failure = overrides.fail?.(call);
    if (failure) return { _tag: "Failure", error: failure } as never;
    if (tag === "preview")
      return {
        _tag: "Success",
        value: {
          notes:
            request.environmentId === "m4"
              ? [{ name: "plan.md", revision: 1, content: "kept" }]
              : [],
          ranWhileDisconnected: [],
        },
      } as never;
    return { _tag: "Success", value: {} } as never;
  };
  const newOperationId = vi.fn(() => OPERATION);
  const run = (member: unknown, shared: unknown[] = [main, side, plain]): UnlinkRun => ({
    member: member as never,
    coordinator: main,
    shared: shared as never,
    label: (id) => MACHINES[id] ?? "Machine",
    keptReady: overrides.keptReady ?? true,
    ready: (environmentId) => !(overrides.offline ?? []).includes(environmentId),
    preview: respond("preview"),
    unlink: respond("unlink"),
    newOperationId,
    pending: {
      read: (key) => store.get(key) ?? null,
      write: (key, operationId) => {
        if (operationId === null) store.delete(key);
        else store.set(key, operationId);
      },
    },
  });
  return { calls, store, newOperationId, run };
};

describe("unlinkGuard", () => {
  it("lets a coordinator started beside main leave when nothing follows it", () => {
    expect(unlinkGuard(side, [main, side, plain])).toEqual({ allowed: true, follower: null });
    expect(mayLeave(side, [main, side, plain])).toBe(true);
  });

  it("lets any machine that runs its own coordinator leave, and refuses one still on the old version", () => {
    // Every active machine is an equal: the guard holds none of them back.
    expect(unlinkGuard(main, [main, side])).toEqual({ allowed: true, follower: null });
    expect(unlinkGuard(plain, [main, side, plain])).toEqual({ allowed: false, follower: null });
    expect(mayLeave(plain, [main, side, plain])).toBe(false);
  });

  it("refuses a side coordinator alone in its list", () => {
    const alone = copy("m5", "side", { state: "active", epoch: 2 }, identity([ref("m5", "side")]));
    expect(unlinkGuard(alone, [main, alone])).toEqual({ allowed: false, follower: null });
  });

  it("refuses when a loaded machine names this one as its coordinator's successor, and names it", () => {
    const follows = copy("m1", "plain", { state: "transferred", successor: ref("m5", "side") });
    const guard = unlinkGuard(side, [main, side, follows]);
    expect(guard.allowed).toBe(false);
    expect(guard.follower).toBe(follows);
    expect(mayLeave(side, [main, side, follows])).toBe(false);
  });
});

describe("runUnlink", () => {
  it("copies the kept notes when the coordinator's machine is ready, then removes the member there", async () => {
    const { calls, store, run } = fakes();
    const said = await runUnlink(run(plain));
    expect(calls.map((call) => [call.tag, call.environmentId])).toEqual([
      ["preview", "m4"],
      ["preview", "m1"],
      ["unlink", "m1"],
      ["unlink", "m4"],
      // Every machine that stays is told, not only the one the unlink ran through.
      ["unlink", "m5"],
    ]);
    const [left, removed, told] = calls.filter((call) => call.tag === "unlink");
    expect(told!.input).toEqual({
      side: "coordinator",
      operationId: OPERATION,
      projectId: "side",
      member: ref("m1", "plain"),
    });
    expect(left!.input).toEqual({
      side: "member",
      operationId: OPERATION,
      projectId: "plain",
      notes: [{ name: "plan.md", content: "kept", expectedRevision: null }],
    });
    expect(removed!.input).toEqual({
      side: "coordinator",
      operationId: OPERATION,
      projectId: "main",
      member: ref("m1", "plain"),
    });
    expect(said).toBe("M1 has its own coordinator again, with a copy of this project's notes.");
    expect(store.size).toBe(0);
  });

  it("asks the member to leave its coordinator only when the guard allows it", async () => {
    const plainRun = fakes();
    await runUnlink(plainRun.run(plain));
    expect(plainRun.calls.find((call) => call.tag === "unlink")!.input).not.toHaveProperty(
      "leaveCoordinator",
    );

    const sideRun = fakes();
    await runUnlink(sideRun.run(side));
    expect(sideRun.calls.find((call) => call.tag === "unlink")!.input).toMatchObject({
      side: "member",
      projectId: "side",
      leaveCoordinator: true,
    });

    const follows = copy("m1", "plain", { state: "transferred", successor: ref("m5", "side") });
    const guarded = fakes();
    await runUnlink(guarded.run(side, [main, side, follows]));
    expect(guarded.calls.find((call) => call.tag === "unlink")!.input).not.toHaveProperty(
      "leaveCoordinator",
    );
  });

  it("tells the person to update an older app that refuses a leaving coordinator", async () => {
    const { calls, store, run } = fakes({
      fail: (call) =>
        call.tag === "unlink" && call.environmentId === "m5"
          ? Object.assign(new Error("not linked"), { code: "not_linked" })
          : null,
    });
    await expect(runUnlink(run(side))).rejects.toThrow("Update SpecWithCode on M5 to unlink it.");
    // The coordinator's machine is never asked to drop it.
    expect(calls.filter((call) => call.tag === "unlink").map((call) => call.environmentId)).toEqual(
      ["m5"],
    );
    expect([...store.values()]).toEqual([OPERATION]);
  });

  it("passes not_linked through for a plain copy, which was not asked to leave a coordinator", async () => {
    const cause = Object.assign(new Error("not linked"), { code: "not_linked" });
    const { run } = fakes({ fail: (call) => (call.tag === "unlink" ? cause : null) });
    await expect(runUnlink(run(plain))).rejects.toBe(cause);
  });

  it("leaves without notes while the coordinator's machine is not connected, and clears the pending operation", async () => {
    const { calls, store, run } = fakes({ keptReady: false });
    const said = await runUnlink(run(plain));
    expect(calls).toEqual([
      {
        tag: "unlink",
        environmentId: "m1",
        input: { side: "member", operationId: OPERATION, projectId: "plain", notes: [] },
      },
    ]);
    expect(said).toBe(
      "M1 has its own coordinator again. Its notes were not copied because M4 is not connected. Connect M4 and remove M1 there.",
    );
    expect(store.size).toBe(0);
  });

  it("keeps the pending operation after a failure, so a retry replays the same operationId", async () => {
    let failing = true;
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const { calls, store, newOperationId, run } = fakes({
      fail: (call) =>
        failing && call.tag === "unlink" && call.input.side === "coordinator"
          ? new Error("M4 did not answer.")
          : null,
    });
    newOperationId.mockImplementation(() => ids.shift()!);
    await expect(runUnlink(run(plain))).rejects.toThrow("M4 did not answer.");
    expect([...store.values()]).toEqual(["11111111-1111-4111-8111-111111111111"]);

    failing = false;
    calls.length = 0;
    await runUnlink(run(plain));
    expect(newOperationId).toHaveBeenCalledTimes(1);
    expect(
      calls.filter((call) => call.tag === "unlink").map((call) => call.input.operationId),
    ).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(store.size).toBe(0);
  });

  it("throws a failed preview and sends no unlink", async () => {
    const { calls, run } = fakes({
      fail: (call) => (call.tag === "preview" ? new Error("M4 could not read its notes.") : null),
    });
    await expect(runUnlink(run(plain))).rejects.toThrow("M4 could not read its notes.");
    expect(calls.some((call) => call.tag === "unlink")).toBe(false);
  });

  it("still unlinks when another machine that stays is away or refuses; it learns on its next sync", async () => {
    const away = fakes({ offline: ["m5"] });
    await runUnlink(away.run(plain));
    expect(
      away.calls.filter((call) => call.tag === "unlink").map((call) => call.environmentId),
    ).toEqual(["m1", "m4"]);
    expect(away.store.size).toBe(0);

    const refuses = fakes({
      fail: (call) =>
        call.tag === "unlink" && call.environmentId === "m5" ? new Error("busy") : null,
    });
    await expect(runUnlink(refuses.run(plain))).resolves.toContain("M1 has its own coordinator");
    expect(refuses.store.size).toBe(0);
  });
});
