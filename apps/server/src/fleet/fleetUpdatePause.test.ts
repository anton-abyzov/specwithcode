import type {
  ServerPrepareServiceUpdateInput,
  ServerPrepareServiceUpdateResult,
} from "@specweave-studio/contracts";
import type { StudioFleetUpdateMethod } from "@specweave-studio/contracts/studioFleet";
import { UPDATE_PAUSE_SETTING_NAME } from "@specweave-studio/shared/updatePause";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  flattenFleetUpdateStatus,
  type FleetUpdateWorkerDeps,
  makeFleetUpdateWorker,
} from "./fleetUpdate.ts";
import { pausesWorkFrom } from "./fleetUpdatePause.ts";

// ---------------------------------------------------------------------------
// A machine whose "Pause running work for updates" decides what a fleet update may stop
// ---------------------------------------------------------------------------

/** What runs on the machine. A drain stops the turns; copies are never stopped by one. */
interface Machine {
  runs: number;
  folderCopies: number;
}

interface Fakes {
  readonly agentCalls: Array<ReadonlyArray<string>>;
  readonly prepareCalls: Array<ServerPrepareServiceUpdateInput>;
  readonly selfUpdates: string[];
  readonly switched: string[];
  pausesWorkReads: number;
}

const offering = (version: string) => ({
  identity: "m1",
  version: "1.0.109",
  installedVersion: "1.0.109",
  status: "downloaded",
  availableVersion: version,
  downloadedVersion: version,
  installFinalized: true,
  installRequestedAt: null,
  installMode: null,
  installHoldUntil: null,
  installCancelledAt: null,
  installRequest: null,
});

const run = (count: number) => ({
  kind: "run" as const,
  count,
  threadId: null,
  threadTitle: null,
  projectId: null,
  projectTitle: null,
});

function worker(options: {
  readonly pausesWork: boolean;
  readonly method?: StudioFleetUpdateMethod;
  readonly serverVersion?: string;
  readonly machine?: Machine;
  /** Whether a drain is held: only where an update agent offers the release (a macOS service). */
  readonly drainHeld?: boolean;
  /** Work that starts again right after a drain, before the switch-over. */
  readonly restartsAfterDrain?: boolean;
  /** The drain itself fails: a turn that will not stop. */
  readonly drainFails?: boolean;
  /** Another update holds the service (a person's Update now): no lease, yet nothing runs. */
  readonly otherHold?: boolean;
  readonly selfUpdate?: Effect.Effect<unknown, { readonly reason: string }>;
  /** How long a normal install waits for quiet; short, so a busy machine gives up at once. */
  readonly quietMaxMs?: number;
}) {
  const machine = options.machine ?? { runs: 0, folderCopies: 0 };
  const fakes: Fakes = {
    agentCalls: [],
    prepareCalls: [],
    selfUpdates: [],
    switched: [],
    pausesWorkReads: 0,
  };
  const deps: FleetUpdateWorkerDeps = {
    serverVersion: options.serverVersion ?? "1.0.109",
    method: Effect.succeed(options.method ?? "service-agent"),
    agent: (args) =>
      Effect.sync(() => {
        fakes.agentCalls.push(args);
        if (args[0] === "status") return offering("1.0.110");
        if (args[0] === "check") return { result: "check-requested" };
        return {
          result: "requested",
          request: {
            installRequestedAt: "2026-11-11T13:10:00.000Z",
            installMode: args.includes("--force") ? "force" : "normal",
            installHoldUntil: args.includes("--force") ? "2026-11-11T13:25:00.000Z" : null,
            installRequest: { at: "2026-11-11T13:10:00.000Z", version: args[2] },
          },
        };
      }),
    prepare: (input) =>
      Effect.suspend(() => {
        fakes.prepareCalls.push(input);
        return input.stopWork && options.drainFails === true
          ? Effect.fail({ _tag: "TurnWouldNotStop" } as never)
          : Effect.succeed(answer(input));
      }),
    pausesWork: Effect.sync(() => {
      fakes.pausesWorkReads += 1;
      return options.pausesWork;
    }),
    releasePublished: () => Effect.succeed(true),
    selfUpdate: (version, report) =>
      Effect.gen(function* () {
        fakes.selfUpdates.push(version);
        yield* report("downloading");
        yield* report("installing");
        fakes.switched.push(version);
        return yield* options.selfUpdate ?? Effect.succeed({ targetVersion: version });
      }),
    quietWait: { pollMs: 10, maxMs: options.quietMaxMs ?? 60 },
  };
  function answer(input: ServerPrepareServiceUpdateInput): ServerPrepareServiceUpdateResult {
    if (input.stopWork) {
      machine.runs = options.restartsAfterDrain === true ? 1 : 0;
      return {
        idle: machine.runs === 0 && machine.folderCopies === 0,
        stoppedThreads: 2,
        interruptedRuns: 2,
        blockers: [],
        held: options.drainHeld ?? false,
        openTerminals: 0,
        folderCopies: machine.folderCopies,
      };
    }
    const idle = machine.runs === 0 && machine.folderCopies === 0;
    const leased = input.ifIdle === true && idle && options.otherHold !== true;
    return {
      idle,
      stoppedThreads: 0,
      blockers: machine.runs === 0 ? [] : [run(machine.runs)],
      held: leased,
      ...(leased ? { holdToken: "lease-1" } : {}),
      openTerminals: 0,
      folderCopies: machine.folderCopies,
    };
  }
  return { fakes, deps, machine, service: Effect.runSync(makeFleetUpdateWorker(deps)) };
}

type Service = ReturnType<typeof worker>["service"];

const refusal = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

async function until(
  service: Service,
  done: (status: Effect.Success<Service["status"]>) => boolean,
) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await Effect.runPromise(service.status);
    if (done(status)) return status;
    await Effect.runPromise(Effect.sleep("5 millis"));
  }
  throw new Error("the worker never reached the expected state");
}

/** A boot-service install that has ended: switched over or failed. */
const ended = (status: { readonly phase: string }) =>
  status.phase === "failed" || status.phase === "handed-off";

const DRAIN = { stopWork: true, hold: true, reason: "install" };
const LOOK = { stopWork: false, hold: true, ifIdle: true, reason: "install" };

describe("a forced fleet update and the machine's own setting", () => {
  it("is refused while the setting is off, before anything is stopped or asked of the agent", async () => {
    for (const method of ["service-agent", "boot-service"] as const) {
      const { fakes, service } = worker({ pausesWork: false, method });
      const error = await refusal(
        service.request({ version: "1.0.110", mode: "force", holdMinutes: 10 }),
      );
      // `busy`: a primary older than the setting decodes it.
      expect(error).toMatchObject({ reason: "busy" });
      expect(error.message).toContain(`"${UPDATE_PAUSE_SETTING_NAME}" is off on this machine`);
      expect(error.message).toContain("left on 1.0.109 until it is quiet");
      expect(error.message).toContain("its owner's setting, not a failure");
      expect(error.message).toContain("A normal request (without force) installs 1.0.110");
      expect(fakes.prepareCalls).toEqual([]);
      expect(fakes.agentCalls).toEqual([]);
      expect(fakes.selfUpdates).toEqual([]);
      expect(await Effect.runPromise(service.status)).toMatchObject({ phase: "idle" });
    }
  });

  it("leaves a normal install that waits for quiet alone when a refused force arrives", async () => {
    const machine = { runs: 0, folderCopies: 1 };
    const { fakes, service } = worker({
      pausesWork: false,
      method: "boot-service",
      machine,
      quietMaxMs: 5_000,
    });
    await Effect.runPromise(service.request({ version: "1.0.110", mode: "normal" }));
    await until(service, (status) => status.phase === "requested");
    const looks = fakes.prepareCalls.length;
    expect(await refusal(service.request({ version: "1.0.110", mode: "force" }))).toMatchObject({
      reason: "busy",
    });
    // The wait goes on: it still looks, and installs once the copy ends.
    expect(await Effect.runPromise(service.status)).toMatchObject({ phase: "requested" });
    machine.folderCopies = 0;
    expect(await until(service, (status) => status.phase === "handed-off")).toMatchObject({
      targetVersion: "1.0.110",
    });
    expect(fakes.prepareCalls.length).toBeGreaterThan(looks);
    expect(fakes.prepareCalls.every((call) => !call.stopWork)).toBe(true);
  });

  it("drains, holds and writes the forced request as before while the setting is on", async () => {
    const { fakes, service } = worker({ pausesWork: true, drainHeld: true });
    expect(
      await Effect.runPromise(
        service.request({ version: "1.0.110", mode: "force", holdMinutes: 10 }),
      ),
    ).toMatchObject({ method: "service-agent", result: "accepted", phase: "draining" });
    expect(
      await until(service, (status) => status.phase === "requested" || status.phase === "failed"),
    ).toMatchObject({ phase: "requested" });
    expect(fakes.prepareCalls).toEqual([DRAIN]);
    expect(fakes.agentCalls).toContainEqual([
      "request",
      "--version",
      "1.0.110",
      "--force",
      "--hold-minutes",
      "10",
      "--kickstart",
    ]);
  });

  it("reports the setting in its status, for every install method, and the primary passes it on", async () => {
    for (const method of ["service-agent", "boot-service"] as const)
      for (const pausesWork of [false, true]) {
        const { service } = worker({ pausesWork, method });
        const status = await Effect.runPromise(service.status);
        expect(status.pauseWorkForUpdates).toBe(pausesWork);
        expect(flattenFleetUpdateStatus(status, "connect")).toMatchObject({
          pauseWorkForUpdates: pausesWork,
        });
      }
  });

  it("reads the setting again on each call, so a change applies to the next request", async () => {
    let on = false;
    const { deps } = worker({ pausesWork: false });
    const service = Effect.runSync(
      makeFleetUpdateWorker({ ...deps, pausesWork: Effect.sync(() => on) }),
    );
    expect(await refusal(service.request({ version: "1.0.110", mode: "force" }))).toMatchObject({
      reason: "busy",
    });
    on = true;
    expect(
      await Effect.runPromise(service.request({ version: "1.0.110", mode: "force" })),
    ).toMatchObject({ result: "accepted" });
  });
});

describe("pausesWorkFrom", () => {
  const read = (getSettings: Effect.Effect<object, { readonly _tag: string }>) =>
    Effect.runPromise(pausesWorkFrom({ getSettings: getSettings as never }));

  it("is the machine's setting, off unless its owner turned it on", async () => {
    expect(await read(Effect.succeed({}))).toBe(false);
    expect(await read(Effect.succeed({ pauseWorkForUpdates: false }))).toBe(false);
    expect(await read(Effect.succeed({ pauseWorkForUpdates: true }))).toBe(true);
  });

  it("is off while threads would not continue after the restart", async () => {
    expect(
      await read(
        Effect.succeed({ pauseWorkForUpdates: true, continueThreadsAfterServerUpdate: false }),
      ),
    ).toBe(false);
  });

  it("reads as off when the settings cannot be read, and reads them on every call", async () => {
    expect(await read(Effect.fail({ _tag: "SettingsUnreadable" }))).toBe(false);
    let on = false;
    const rule = pausesWorkFrom({
      getSettings: Effect.sync(() => ({ pauseWorkForUpdates: on })) as never,
    });
    expect(await Effect.runPromise(rule)).toBe(false);
    on = true;
    expect(await Effect.runPromise(rule)).toBe(true);
  });
});

describe("a normal update on a Linux boot service that stays busy", () => {
  const linux = (
    pausesWork: boolean,
    machine: Machine,
    extra: Partial<Parameters<typeof worker>[0]> = {},
  ) => worker({ pausesWork, method: "boot-service", serverVersion: "1.0.236", machine, ...extra });

  it("is left on its version with the setting off, says why, and stops nothing", async () => {
    const { fakes, service } = linux(false, { runs: 2, folderCopies: 0 });
    await Effect.runPromise(service.request({ version: "1.0.241", mode: "normal" }));
    const failed = await until(service, ended);
    expect(failed).toMatchObject({ phase: "failed", lastErrorReason: "busy" });
    expect(failed.lastError).toContain("1.0.241 was not installed after");
    expect(failed.lastError).toContain("2 running tasks");
    expect(failed.lastError).toContain(`"${UPDATE_PAUSE_SETTING_NAME}" is off`);
    expect(failed.lastError).toContain("its owner's setting, not a failure");
    expect(failed.lastError).not.toContain("force the update");
    expect(fakes.prepareCalls.length).toBeGreaterThan(0);
    expect(fakes.prepareCalls.every((call) => !call.stopWork && call.ifIdle === true)).toBe(true);
    expect(fakes.switched).toEqual([]);
  });

  it("stops the work after its wait with the setting on, closes admission and switches over", async () => {
    const { fakes, service } = linux(true, { runs: 2, folderCopies: 0 });
    await Effect.runPromise(service.request({ version: "1.0.241", mode: "normal" }));
    expect(await until(service, (status) => status.phase === "handed-off")).toMatchObject({
      targetVersion: "1.0.241",
    });
    // The quiet looks, then the drain Update now makes (not held: no update agent here),
    // then the if-idle hold that closes admission until the switch-over.
    const drainAt = fakes.prepareCalls.findIndex((call) => call.stopWork);
    expect(drainAt).toBeGreaterThan(0);
    expect(fakes.prepareCalls.slice(0, drainAt).every((call) => call.ifIdle === true)).toBe(true);
    expect(fakes.prepareCalls.slice(drainAt)).toEqual([DRAIN, LOOK]);
    expect(fakes.switched).toEqual(["1.0.241"]);
  });

  it("still switches over when work started again in the seconds after the drain", async () => {
    // The restart cancels that turn and it continues after it; turning back would leave
    // the turns just interrupted waiting for a restart that never comes.
    const { fakes, service } = linux(
      true,
      { runs: 2, folderCopies: 0 },
      { restartsAfterDrain: true },
    );
    await Effect.runPromise(service.request({ version: "1.0.241", mode: "normal" }));
    expect(await until(service, ended)).toMatchObject({ phase: "handed-off" });
    expect(fakes.prepareCalls.slice(-2)).toEqual([DRAIN, LOOK]);
    expect(fakes.prepareCalls.some((call) => call.releaseHold === true)).toBe(false);
  });

  it("never stops work for a folder copy, even with the setting on", async () => {
    const { fakes, service } = linux(true, { runs: 1, folderCopies: 1 });
    await Effect.runPromise(service.request({ version: "1.0.241", mode: "normal" }));
    const failed = await until(service, ended);
    expect(failed).toMatchObject({ phase: "failed", lastErrorReason: "busy" });
    expect(failed.lastError).toContain("1 folder copy");
    expect(fakes.prepareCalls.some((call) => call.stopWork)).toBe(false);
    expect(fakes.switched).toEqual([]);
  });

  it("releases the hold it took when the self-update fails after the pause", async () => {
    const { fakes, service } = linux(
      true,
      { runs: 2, folderCopies: 0 },
      { selfUpdate: Effect.fail({ reason: "launcher refused" }) },
    );
    await Effect.runPromise(service.request({ version: "1.0.241", mode: "normal" }));
    expect(await until(service, ended)).toMatchObject({
      phase: "failed",
      lastErrorReason: "failed",
      lastError: "launcher refused",
    });
    expect(fakes.prepareCalls.at(-1)).toEqual({
      stopWork: false,
      releaseHold: true,
      holdToken: "lease-1",
    });
  });

  it("releases a held drain the same way when nothing switches over", async () => {
    const { fakes, service } = linux(
      true,
      { runs: 2, folderCopies: 0 },
      { drainHeld: true, selfUpdate: Effect.fail({ reason: "launcher refused" }) },
    );
    await Effect.runPromise(service.request({ version: "1.0.241", mode: "normal" }));
    await until(service, ended);
    // Held by the drain, so no if-idle hold was taken on top of it.
    expect(fakes.prepareCalls.filter((call) => call.stopWork)).toEqual([DRAIN]);
    expect(fakes.prepareCalls.at(-2)).toEqual(DRAIN);
    expect(fakes.prepareCalls.at(-1)).toEqual({ stopWork: false, releaseHold: true });
  });

  it("stops nothing when only another update's hold kept it waiting, even with the setting on", async () => {
    // A person's Update now holds the service: no turn runs, so a pause would end nothing.
    const { fakes, service } = linux(true, { runs: 0, folderCopies: 0 }, { otherHold: true });
    await Effect.runPromise(service.request({ version: "1.0.241", mode: "normal" }));
    const failed = await until(service, ended);
    expect(failed).toMatchObject({ phase: "failed", lastErrorReason: "busy" });
    expect(failed.lastError).toContain("another update hold");
    expect(failed.lastError).toContain("nothing was paused");
    expect(failed.lastError).not.toContain(`"${UPDATE_PAUSE_SETTING_NAME}" is off`);
    expect(fakes.prepareCalls.some((call) => call.stopWork)).toBe(false);
    expect(fakes.switched).toEqual([]);
  });

  it("a forced request still switches over when the drain fails", async () => {
    // Force is the way out when a turn will not stop: the restart ends it, as before.
    const { fakes, service } = linux(true, { runs: 2, folderCopies: 0 }, { drainFails: true });
    await Effect.runPromise(service.request({ version: "1.0.241", mode: "force" }));
    expect(await until(service, ended)).toMatchObject({ phase: "handed-off" });
    expect(fakes.prepareCalls).toEqual([DRAIN]);
    expect(fakes.switched).toEqual(["1.0.241"]);
  });

  it("a normal request that cannot stop the work installs nothing", async () => {
    const { fakes, service } = linux(true, { runs: 2, folderCopies: 0 }, { drainFails: true });
    await Effect.runPromise(service.request({ version: "1.0.241", mode: "normal" }));
    expect(await until(service, ended)).toMatchObject({
      phase: "failed",
      lastErrorReason: "failed",
    });
    expect(fakes.switched).toEqual([]);
  });

  it("stops the work first on a forced request too, with the setting on", async () => {
    const { fakes, service } = linux(true, { runs: 2, folderCopies: 0 });
    await Effect.runPromise(service.request({ version: "1.0.241", mode: "force" }));
    expect(await until(service, ended)).toMatchObject({ phase: "handed-off" });
    // No quiet wait: the drain comes first, then the hold for the switch-over.
    expect(fakes.prepareCalls).toEqual([DRAIN, LOOK]);
    expect(fakes.switched).toEqual(["1.0.241"]);
  });
});
