import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type {
  DesktopUpdateState,
  ServerPrepareServiceUpdateInput,
} from "@specweave-studio/contracts";
import { makeIdleAppUpdate } from "./idleAppUpdate.ts";

function fixture() {
  const f = {
    preferences: {
      checkAutomatically: true,
      installAutomatically: true,
      downloadAutomatically: true,
      restartWhenIdle: true,
    },
    idle: 301,
    busy: false,
    unknown: false,
    foreign: false,
    legacy: false,
    losesHold: false,
    current: true,
    fails: false,
    sessionAvailable: true,
    staged: () => {},
    recover: Effect.void,
    calls: [] as ServerPrepareServiceUpdateInput[],
    installs: 0,
    quits: 0,
    state: {
      status: "downloaded",
      downloadedVersion: "1.2.3",
      swapGate: { gate: "open" },
    } as DesktopUpdateState,
  };
  const prepare = (input: ServerPrepareServiceUpdateInput) =>
    Effect.sync(() => {
      f.calls.push(input);
      // A plain prepare look can cancel queued work under somebody else's hold.
      if (!input.ifIdle && !input.releaseHold) throw new Error("Mutating idle probe");
      if (f.unknown) return null;
      return {
        idle: !f.busy,
        stoppedThreads: 0,
        blockers: [],
        held: !f.foreign && input.hold === true,
        ...(input.hold && !f.legacy && !f.foreign
          ? { holdToken: f.losesHold && input.holdToken ? "another" : "mine" }
          : {}),
      };
    });
  const controller = makeIdleAppUpdate({
    preferences: Effect.sync(() => f.preferences),
    state: Effect.sync(() => f.state),
    idleSeconds: Effect.sync(() => f.idle),
    session: Effect.sync(() =>
      f.sessionAvailable ? { prepare, current: Effect.sync(() => f.current) } : null,
    ),
    install: (_version, beforeQuit, afterFailure) =>
      Effect.gen(function* () {
        f.recover = afterFailure;
        f.installs++;
        f.staged();
        if (!(yield* beforeQuit)) return { accepted: false };
        if (f.fails) return { accepted: true, failed: true };
        f.quits++;
        return { accepted: true };
      }),
  });
  return { f, tick: () => Effect.runPromise(controller.tick) };
}

describe("automatic idle app installation", () => {
  it("installs with no renderer, taking and confirming its own hold after staging", async () => {
    const { f, tick } = fixture();
    f.staged = () => expect(f.calls).toEqual([]);
    await tick();
    expect(f.quits).toBe(1);
    expect(f.calls).toEqual([
      { stopWork: false, hold: true, ifIdle: true, reason: "app-restart" },
      { stopWork: false, hold: true, ifIdle: true, holdToken: "mine", reason: "app-restart" },
    ]);
    await tick();
    expect(f.quits).toBe(1);
  });
  it("releases its lease if recovery runs after an accepted install", async () => {
    const { f, tick } = fixture();
    await tick();
    expect(f.calls.some((call) => call.releaseHold)).toBe(false);
    await Effect.runPromise(f.recover);
    expect(f.calls.at(-1)).toEqual({
      stopWork: false,
      releaseHold: true,
      holdToken: "mine",
      reason: "app-restart",
    });
    await Effect.runPromise(f.recover);
    expect(f.calls.filter((call) => call.releaseHold)).toHaveLength(1);
  });
  for (const reason of [
    "opt-out",
    "checks-off",
    "installs-off",
    "active-person",
    "busy",
    "unknown",
    "foreign",
    "secondary",
    "gate",
  ] as const) {
    it(`does not restart for ${reason}`, async () => {
      const { f, tick } = fixture();
      if (reason === "opt-out") f.preferences.restartWhenIdle = false;
      if (reason === "checks-off") f.preferences.checkAutomatically = false;
      if (reason === "installs-off") f.preferences.installAutomatically = false;
      if (reason === "active-person") f.idle = 1;
      if (reason === "busy") f.busy = true;
      if (reason === "unknown") f.unknown = true;
      if (reason === "foreign") f.foreign = true;
      if (reason === "secondary") f.sessionAvailable = false;
      if (reason === "gate")
        f.state = { ...f.state, swapGate: { ...f.state.swapGate!, gate: "closed" } };
      await tick();
      expect(f.installs).toBe(["busy", "unknown", "foreign"].includes(reason) ? 1 : 0);
      expect(f.quits).toBe(0);
    });
  }
  for (const reason of [
    "busy",
    "person",
    "opt-out",
    "changed-service",
    "legacy",
    "lost-hold",
    "failure",
  ] as const) {
    it(`rechecks at the commit boundary: ${reason}`, async () => {
      const { f, tick } = fixture();
      f.staged = () => {
        if (reason === "busy") f.busy = true;
        if (reason === "person") f.idle = 0;
        if (reason === "opt-out") f.preferences.installAutomatically = false;
        if (reason === "changed-service") f.current = false;
        if (reason === "legacy") f.legacy = true;
        if (reason === "lost-hold") f.losesHold = true;
        if (reason === "failure") f.fails = true;
      };
      await tick();
      expect(f.quits).toBe(0);
      expect(f.calls.every((call) => !call.stopWork)).toBe(true);
      const release = f.calls.find((call) => call.releaseHold);
      if (["busy", "lost-hold", "failure"].includes(reason))
        expect(release?.holdToken).toBe("mine");
      else expect(release).toBeUndefined();
      await tick();
      expect(f.installs).toBe(1);
    });
  }
});
