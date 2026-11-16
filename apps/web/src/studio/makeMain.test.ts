import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: null }));

const {
  makeMain,
  makeMainBlockText,
  makeMainPath,
  mainOffer,
  pendingMainMove,
  requestMainMove,
  subscribeMainMove,
  takeMainMove,
  waitMinutes,
} = await import("./makeMain");
const { TAKEOVER_UNREACHABLE_MS } = await import("./projectLink");
type Machines = Parameters<typeof makeMainPath>[2];

const NOW = 1_800_000_000_000;
const ref = (environmentId: string, projectId = "p") => ({
  environmentId,
  projectId,
  coordinatorThreadId: `project-coordinator:${projectId}`,
});
const identity = (...machines: string[]) => ({
  id: "atlas",
  title: "Atlas",
  coordinatorId: "coordinator:atlas",
  members: machines.map((machine) => ref(machine)),
});
/** One machine's copy: main (active), a copy that handed main to `successor`, or unlinked. */
const copy = (
  environmentId: string,
  binding?: {
    state: "active" | "transferred" | "transferring";
    epoch?: number;
    successor?: string;
    predecessor?: string;
  },
  linked: readonly string[] | null = ["m4", "m5", "mini"],
) =>
  ({
    environmentId,
    id: "p",
    title: "Atlas",
    workspaceRoot: `/${environmentId}/atlas`,
    workspaceSettings: {
      kind: "code",
      ...(linked ? { logicalProject: identity(...linked) } : {}),
      ...(binding
        ? {
            coordinatorBinding: {
              epoch: binding.epoch ?? 2,
              state: binding.state,
              ...(binding.successor ? { successor: ref(binding.successor) } : {}),
              ...(binding.predecessor ? { predecessor: ref(binding.predecessor) } : {}),
            },
          }
        : {}),
    },
  }) as unknown as EnvironmentProject;

const m4 = copy("m4", { state: "active" });
const m5 = copy("m5", { state: "transferred", successor: "m4" });
const mini = copy("mini", { state: "transferred", successor: "m4" });
const members = [m4, m5, mini];

/** Every machine connected and permitted, unless a test says otherwise. */
const machines = (over: Partial<Machines> & { offline?: readonly string[] } = {}): Machines => {
  const offline = new Set(over.offline ?? []);
  return {
    connected: (id) => !offline.has(id),
    unreachableSince: (id) => (offline.has(id) ? NOW - TAKEOVER_UNREACHABLE_MS : null),
    now: NOW,
    canMoveFrom: () => true,
    takeoverReady: () => true,
    ...over,
  };
};

describe("makeMainPath", () => {
  it("moves the coordinator while the old main is connected", () => {
    expect(makeMainPath(m5, members, machines())).toEqual({ kind: "move", main: m4 });
  });

  it("takes over once the old main has been unreachable for 10 minutes", () => {
    expect(makeMainPath(m5, members, machines({ offline: ["m4"] }))).toEqual({
      kind: "takeover",
      main: m4,
    });
  });

  it("stays off before 10 minutes and says how long is left", () => {
    const path = makeMainPath(
      m5,
      members,
      machines({ offline: ["m4"], unreachableSince: () => NOW - 3 * 60_000 }),
    );
    expect(path).toEqual({ kind: "blocked", main: m4, reason: "waiting", waitMs: 7 * 60_000 });
    // A machine this device never saw connected counts from when it was first found gone.
    expect(
      makeMainPath(m5, members, machines({ offline: ["m4"], unreachableSince: () => NOW })),
    ).toMatchObject({ reason: "waiting", waitMs: TAKEOVER_UNREACHABLE_MS });
  });

  it("gives no switch to main, an unlinked checkout, a copy mid-move or one that also coordinates", () => {
    expect(makeMainPath(m4, members, machines())).toEqual({ kind: "none" });
    const unlinked = copy("m1", { state: "active" }, null);
    expect(makeMainPath(unlinked, [...members, unlinked], machines())).toEqual({ kind: "none" });
    const moving = copy("m5", { state: "transferring" });
    expect(makeMainPath(moving, [m4, moving], machines())).toEqual({ kind: "none" });
    // An older epoch that still coordinates beside main: neither way in would accept it.
    const alsoMain = copy("mini", { state: "active", epoch: 1 });
    expect(makeMainPath(alsoMain, [m4, alsoMain], machines())).toEqual({ kind: "none" });
  });

  it("gives no switch when main is not in sight or sits on the copy's own machine", () => {
    expect(makeMainPath(m5, [m5], machines())).toEqual({ kind: "none" });
    const sameMachine = { ...copy("m4", { state: "transferred", successor: "m4" }), id: "other" };
    expect(makeMainPath(sameMachine as EnvironmentProject, [m4, sameMachine], machines())).toEqual({
      kind: "none",
    });
  });

  it("refuses the online move from a window that can only read the old main", () => {
    const path = makeMainPath(m5, members, machines({ canMoveFrom: (id) => id !== "m4" }));
    expect(path).toEqual({ kind: "blocked", main: m4, reason: "main-read-only", waitMs: 0 });
    expect(makeMainBlockText(path as never, { machine: "M5", main: "m4" }).reason).toEqual({
      text: "This window can only read {main}, so it cannot move main from there. Open SpecWithCode on {main}, or connect to it with full access, to make {machine} main.",
      values: { machine: "M5", main: "m4" },
    });
  });

  it("needs the copy's own machine, connected and able to take over", () => {
    expect(makeMainPath(m5, members, machines({ offline: ["m5"] }))).toMatchObject({
      kind: "blocked",
      reason: "copy-offline",
    });
    expect(
      makeMainPath(m5, members, machines({ offline: ["m4"], takeoverReady: () => false })),
    ).toMatchObject({ kind: "blocked", reason: "copy-not-ready" });
  });

  it("reads roles from the copy's own project, not from unlinked checkouts beside it", () => {
    // Another project for the same repository sits in the row at a higher epoch.
    const stranger = copy("m1", { state: "active", epoch: 9 }, null);
    expect(makeMainPath(m5, [stranger, ...members], machines())).toEqual({
      kind: "move",
      main: m4,
    });
  });

  it("leaves a machine's old record out as main", () => {
    const old = copy("m4-old", { state: "active", epoch: 5 }, ["m4", "m4-old", "m5"]);
    const current = copy("m4", { state: "active", epoch: 2 }, ["m4", "m4-old", "m5"]);
    const joined = copy("m5", { state: "transferred", successor: "m4" }, ["m4", "m4-old", "m5"]);
    const path = makeMainPath(
      joined,
      [old, current, joined],
      machines({ retired: new Set(["m4-old"]) }),
    );
    expect(path).toEqual({ kind: "move", main: current });
  });
});

describe("makeMainBlockText", () => {
  it("says when an offline switch unlocks, in a sentence and in a few words", () => {
    const text = makeMainBlockText(
      { reason: "waiting", waitMs: 6.2 * 60_000 },
      { machine: "M5", main: "m4" },
    );
    expect(text.reason).toEqual({
      text: "{main} must be unreachable for 10 minutes before {machine} can become main. That unlocks in {minutes} min.",
      values: { machine: "M5", main: "m4", minutes: "7" },
    });
    expect(text.note).toEqual({
      text: "in {minutes} min",
      values: { machine: "M5", main: "m4", minutes: "7" },
    });
    expect(waitMinutes(1)).toBe(1);
    expect(waitMinutes(0)).toBe(1);
  });

  it("names the machine to fix for the other reasons", () => {
    const names = { machine: "M5", main: "m4" };
    expect(makeMainBlockText({ reason: "copy-offline", waitMs: 0 }, names).note.text).toBe(
      "{machine} offline",
    );
    expect(makeMainBlockText({ reason: "copy-not-ready", waitMs: 0 }, names).reason.text).toContain(
      "{machine} cannot take over yet.",
    );
    expect(makeMainBlockText({ reason: "main-read-only", waitMs: 0 }, names).note.text).toBe(
      "read-only on {main}",
    );
  });
});

describe("makeMain", () => {
  const taken = (epoch = 3) => ({
    _tag: "Success" as const,
    value: {
      operationId: "op",
      logicalProject: identity("m4", "m5", "mini"),
      coordinatorBinding: { epoch, state: "active" as const },
      notesWritten: 0,
      replicaFrom: "2026-11-16T10:00:00.000Z",
      replayed: false,
    },
  });
  const run = (over: Partial<Parameters<typeof makeMain>[1]> & { offline?: readonly string[] }) => {
    const calls = {
      move: vi.fn(),
      takeover: vi.fn<(request: unknown) => Promise<unknown>>(async () => taken()),
      acceptStandby: vi.fn(async () => ({ _tag: "Success" as const, value: {} })),
    };
    return {
      calls,
      input: {
        ...machines(over),
        members,
        move: calls.move,
        takeover: calls.takeover,
        acceptStandby: calls.acceptStandby,
        rearms: () => true,
        newOperationId: () => "op",
        ...over,
      } as unknown as Parameters<typeof makeMain>[1],
    };
  };

  it("opens the existing coordinator move while the old main is connected", async () => {
    const { calls, input } = run({});
    expect(await makeMain(m5, input)).toEqual({ status: "moving", main: m4 });
    expect(calls.move).toHaveBeenCalledWith(m4, m5);
    expect(calls.takeover).not.toHaveBeenCalled();
  });

  it("takes over from an unreachable main, naming it as the copy that gives way", async () => {
    const { calls, input } = run({ offline: ["m4"] });
    expect(await makeMain(m5, input)).toEqual({
      status: "main",
      previous: m4,
      replicaFrom: "2026-11-16T10:00:00.000Z",
    });
    expect(calls.takeover).toHaveBeenCalledWith({
      environmentId: "m5",
      input: { operationId: "op", projectId: "p", knownEpoch: 2, predecessor: ref("m4") },
    });
    expect(calls.move).not.toHaveBeenCalled();
    // Reachable copies' standbys stand down for the new epoch; the unreachable main gets no call.
    expect(calls.acceptStandby).toHaveBeenCalledTimes(1);
    expect(calls.acceptStandby).toHaveBeenCalledWith({
      environmentId: "mini",
      input: { projectId: "p", logicalProjectId: "atlas", standby: null, belowEpoch: 3 },
    });
  });

  it("names the main in sight now, not the one the copy recorded when it joined", async () => {
    // Main moved m4 -> mini after m5 joined: m5 still records m4 as its successor.
    const oldMain = copy("m4", { state: "transferred", successor: "mini", epoch: 3 });
    const newMain = copy("mini", { state: "active", predecessor: "m4", epoch: 3 });
    const { calls, input } = run({ offline: ["mini"], members: [oldMain, m5, newMain] });
    await makeMain(m5, input);
    expect(calls.takeover.mock.calls[0]?.[0]).toMatchObject({
      input: { knownEpoch: 3, predecessor: ref("mini") },
    });
  });

  it("runs nothing while the switch is off, and says why", async () => {
    const { calls, input } = run({
      offline: ["m4"],
      unreachableSince: () => NOW - 60_000,
    });
    expect(await makeMain(m5, input)).toEqual({
      status: "blocked",
      main: m4,
      reason: "waiting",
      waitMs: 9 * 60_000,
    });
    expect(await makeMain(m4, input)).toEqual({ status: "none" });
    expect(calls.takeover).not.toHaveBeenCalled();
    expect(calls.move).not.toHaveBeenCalled();
  });

  it("throws the cause of a takeover that failed, and disarms nothing", async () => {
    const { calls, input } = run({ offline: ["m4"] });
    calls.takeover.mockResolvedValueOnce({
      _tag: "Failure",
      cause: new Error("Another copy took over in a way this copy cannot confirm."),
    } as never);
    await expect(makeMain(m5, input)).rejects.toThrow("Another copy took over");
    expect(calls.acceptStandby).not.toHaveBeenCalled();
  });
});

describe("mainOffer", () => {
  const names = { machine: "M5", main: "m4" };
  it("is pressable for a move or a takeover, and off with its reason otherwise", () => {
    expect(mainOffer("m5:p", { kind: "none" }, names)).toBeNull();
    expect(mainOffer("m5:p", { kind: "move", main: m4 }, names)).toEqual({
      key: "m5:p",
      machine: "M5",
      main: "m4",
      kind: "move",
      reason: null,
      note: null,
    });
    expect(mainOffer("m5:p", { kind: "takeover", main: m4 }, names)?.kind).toBe("takeover");
    const off = mainOffer(
      "m5:p",
      { kind: "blocked", main: m4, reason: "waiting", waitMs: 60_000 },
      names,
    );
    expect(off).toMatchObject({ kind: "blocked", note: { text: "in {minutes} min" } });
    expect(off?.reason?.values).toEqual({ machine: "M5", main: "m4", minutes: "1" });
  });
});

describe("a move asked for from the copy's page", () => {
  it("waits for main's page and is taken once", () => {
    const heard = vi.fn();
    const stop = subscribeMainMove(heard);
    requestMainMove({ from: "m4:p", to: "m5:p", returnTo: "m5:p" });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(pendingMainMove("m5:p")).toBeNull();
    expect(takeMainMove("mini:p")).toBeNull();
    expect(takeMainMove("m4:p")).toEqual({ from: "m4:p", to: "m5:p", returnTo: "m5:p" });
    expect(takeMainMove("m4:p")).toBeNull();
    stop();
    requestMainMove({ from: "m4:p", to: "m5:p", returnTo: null });
    expect(heard).toHaveBeenCalledTimes(2);
    takeMainMove("m4:p");
  });

  it("is dropped when main's page never opened to take it", () => {
    requestMainMove({ from: "m4:p", to: "m5:p", returnTo: "m5:p" }, NOW);
    expect(pendingMainMove("m4:p", NOW + 59_000)).not.toBeNull();
    expect(takeMainMove("m4:p", NOW + 61_000)).toBeNull();
  });
});
