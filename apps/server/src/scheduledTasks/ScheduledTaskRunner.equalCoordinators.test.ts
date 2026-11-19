/**
 * Routines across the move to equal coordinators (1390 AC-35, AC-45): two
 * machines that each believed they coordinated the project, because a
 * takeover happened while the first was offline, never both fire the same
 * due occurrence once every copy is active.
 */
import { assert, it } from "@effect/vitest";
import type { ProjectCoordinatorBinding } from "@specweave-studio/contracts";
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { equalCoordinatorBinding } from "../project/EqualCoordinatorMigration.ts";
import { fleet, type Machine } from "./ScheduledTaskRunner.testkit.ts";

const NOON = "2026-11-03T12:00:00.000Z";
const DUE = "2026-11-03T11:59:00.000Z";
const member = (name: string) => ({
  environmentId: EnvironmentId.make(`env-${name}`),
  projectId: ProjectId.make(`project-${name}`),
  coordinatorThreadId: ThreadId.make(`project-coordinator:project-${name}`),
});

/** Alpha went offline with beta armed as its standby, and never saw what followed. */
const BEFORE_ALPHA: ProjectCoordinatorBinding = {
  epoch: 1,
  state: "active",
  standby: { member: member("beta"), afterMinutes: 5, enabledAt: "2026-11-01T00:00:00.000Z" },
} as ProjectCoordinatorBinding;
/** Beta took over while alpha was unreachable. */
const BEFORE_BETA: ProjectCoordinatorBinding = {
  epoch: 2,
  state: "active",
  predecessor: member("alpha"),
  takenOverAt: "2026-11-02T00:00:00.000Z",
  takenOverBy: "auto",
} as ProjectCoordinatorBinding;

const afterTakeover = (order: ReadonlyArray<"alpha" | "beta">) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOON));
    const { machines, network, fires, everyoneLooks } = yield* fleet(["alpha", "beta"], {
      pace: 0,
    });
    const [alpha, beta] = machines as [Machine, Machine];
    // Both start the release with equal coordinators; each migrates the binding it held.
    alpha.state.role = { active: true, epoch: 1, state: "active" };
    beta.state.role = { active: true, epoch: 2, state: "active" };
    alpha.state.binding = equalCoordinatorBinding(BEFORE_ALPHA);
    beta.state.binding = equalCoordinatorBinding(BEFORE_BETA);
    yield* alpha.seed();
    yield* beta.seed();
    yield* alpha.makeDue(DUE);
    yield* beta.makeDue(DUE);
    // The takeover is still outstanding: the two have not spoken since.
    network.offline.add("alpha");
    for (const name of order) yield* (name === "alpha" ? alpha : beta).due;
    return { alpha, beta, network, fires, everyoneLooks };
  });

for (const order of [
  ["alpha", "beta"],
  ["beta", "alpha"],
] as const)
  it.effect(
    `an offline takeover leaves no two owners of a due routine (${order.join(" then ")})`,
    () =>
      Effect.gen(function* () {
        const { network, fires, everyoneLooks } = yield* afterTakeover(order);
        // Neither can tell it is the only one, so the occurrence is held on both.
        assert.equal(fires(), 0);
        // Once they reach each other they settle one runner, and it fires once.
        network.offline.clear();
        // The next paced look after the wait between asks.
        yield* TestClock.adjust("10 minutes");
        yield* everyoneLooks;
        yield* everyoneLooks;
        assert.equal(fires(), 1);
      }),
  );

it("a copy with an armed standby or a takeover does not own the routines alone", () => {
  assert.isFalse(equalCoordinatorBinding(BEFORE_ALPHA).routineOwner);
  assert.isFalse(equalCoordinatorBinding(BEFORE_BETA).routineOwner);
});
