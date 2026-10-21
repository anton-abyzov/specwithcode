import { assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { HANDOFF_SLEEP_ACTION, registerHandoffSleepNotice } from "./DesktopHandoffSleep.ts";

class NoWindow extends Data.TaggedError("NoWindow")<{}> {}

type PowerEvent = "lock-screen" | "unlock-screen" | "on-ac" | "on-battery" | "suspend" | "resume";

const fakePowerMonitor = () => {
  const listeners = new Map<PowerEvent, Array<() => void>>();
  return {
    emit: (event: PowerEvent) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    onSimpleEvent: (event: PowerEvent, listener: () => void) =>
      Effect.sync(() => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      }),
  };
};

describe("registerHandoffSleepNotice", () => {
  it.effect("asks the window to hand off on suspend, not on screen lock", () =>
    Effect.gen(function* () {
      const monitor = fakePowerMonitor();
      const sent: string[] = [];
      yield* registerHandoffSleepNotice(monitor, (action) =>
        Effect.sync(() => {
          sent.push(action);
        }),
      );
      monitor.emit("lock-screen");
      assert.deepEqual(sent, []);
      monitor.emit("suspend");
      yield* Effect.yieldNow;
      assert.deepEqual(sent, [HANDOFF_SLEEP_ACTION]);
    }).pipe(Effect.scoped),
  );

  it.effect("never throws when the window is gone", () =>
    Effect.gen(function* () {
      const monitor = fakePowerMonitor();
      yield* registerHandoffSleepNotice(monitor, () => Effect.fail(new NoWindow()));
      monitor.emit("suspend");
      yield* Effect.yieldNow;
    }).pipe(Effect.scoped),
  );
});
