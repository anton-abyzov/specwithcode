import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import {
  START,
  copilotReady,
  harness,
  taskInput,
} from "./ScheduledTaskService.providerGate.testkit.ts";

/** An unheld service whose update agent may be applying an automatic install. */
const automaticInstall = (applying: { value: boolean }) =>
  Layer.mock(ServiceUpdateHold.ServiceUpdateHold)({
    current: Effect.succeed(Option.none()),
    installGated: Effect.succeed(false),
    isHeld: Effect.succeed(false),
    awaitReleased: Effect.void,
    recordRefusal: () => Effect.void,
    withAdmission: (_action, effect) => effect,
    automaticInstallApplying: Effect.sync(() => applying.value),
  });

// A command routine with a pre-run check, as a disk-space guard is: every fire
// rewrites its row (last run, next run, run count) whether or not it posts.
const guard = () =>
  taskInput({
    id: "disk-guard",
    prompt: "Disk space is low: clean up.",
    check: { command: "check-disk" },
  });

it.effect("a routine waits, writing nothing, while an automatic install applies", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const applying = { value: false };
    const { state, run, fireNext, taskRow } = yield* harness(
      [copilotReady],
      undefined,
      automaticInstall(applying),
    );
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(guard());
        state.checkExit = 1; // Nothing due: the check stays quiet.
        const before = yield* taskRow;

        // The agent reports installing: the due tick changes no row.
        applying.value = true;
        yield* fireNext;
        assert.deepEqual(yield* taskRow, before);
        assert.lengthOf(state.sent, 0);

        // The install ends: the routine is still due and fires on the next tick.
        applying.value = false;
        yield* state.poll!;
        const after = yield* taskRow;
        assert.equal(after.run_count, before.run_count + 1);
        assert.notEqual(after.next_run_at, before.next_run_at);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("a hold without the agent reading never stops routines", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness(
      [copilotReady],
      undefined,
      Layer.mock(ServiceUpdateHold.ServiceUpdateHold)({
        current: Effect.succeed(Option.none()),
        installGated: Effect.succeed(false),
        isHeld: Effect.succeed(false),
        awaitReleased: Effect.void,
        recordRefusal: () => Effect.void,
        withAdmission: (_action, effect) => effect,
      }),
    );
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(guard());
        state.checkExit = 1;
        const before = yield* taskRow;
        yield* fireNext;
        assert.equal((yield* taskRow).run_count, before.run_count + 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it("counts an install as applying only while the agent's installing state is fresh", () => {
  const at = 1_000_000;
  const bound = ServiceUpdateHold.AGENT_APPLY_TIMEOUT_MS + ServiceUpdateHold.AGENT_RETRY_MS;
  const applying = (status: string, updatedAtMs: number | null, nowMs: number) =>
    ServiceUpdateHold.automaticInstallApplying({ status, updatedAtMs }, nowMs);
  assert.isTrue(applying("installing", at, at + 1_000));
  assert.isTrue(applying("installing", at, at + bound));
  // An agent that died while installing stops counting.
  assert.isFalse(applying("installing", at, at + bound + 1));
  assert.isFalse(applying("installing", null, at));
  // Waiting for quiet can last hours: routines keep running then.
  assert.isFalse(applying("waiting-for-quiet", at, at + 1_000));
  assert.isFalse(applying("installed", at, at + 1_000));
});
