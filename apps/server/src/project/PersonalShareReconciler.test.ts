// @effect-diagnostics anyUnknownInErrorContext:off -- the seat kit stubs services with loosely typed fakes.
/**
 * The reconciler that links the one Percy on the linked-sync tick (1448
 * T-14, AC-17, AC-18): seats link within two ticks, a one-way grant has one
 * driver, a pair with no grant shows `no_grant`, and a pair whose sides both
 * think the other drives still links.
 */
import { assert, describe, it } from "@effect/vitest";
import { CommandId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { personalLinkIdForAccount } from "./personalLinkId.ts";
import {
  contentSent,
  makeShareSeat,
  type Network,
  pairUp,
  reconcileRounds,
  type ShareSeat,
  USER,
} from "./personalShare.testkit.ts";

const LINK = personalLinkIdForAccount(USER);

const stateOf = (seat: ShareSeat, peer: ShareSeat) =>
  seat.states.states.pipe(Effect.map((states) => states.get(peer.environmentId)?.state));

/** Desktop (the lower id) and Laptop, both switches on and each confirmed the other. */
const twoSeats = (starter: "laptop" | "desktop") =>
  Effect.gen(function* () {
    const network: Network = new Map();
    const desktop = yield* makeShareSeat(network, "desktop", "Desktop");
    const laptop = yield* makeShareSeat(network, "laptop", "Laptop");
    laptop.switchOn([desktop.environmentId], starter === "laptop" ? { start: true } : {});
    desktop.switchOn([laptop.environmentId], starter === "desktop" ? { start: true } : {});
    return { network, desktop, laptop };
  });

describe("PersonalShareReconciler", () => {
  for (const starter of ["laptop", "desktop"] as const)
    it.effect(`two seats link within two ticks (AC-17), started on ${starter}`, () =>
      Effect.gen(function* () {
        const { desktop, laptop } = yield* twoSeats(starter);
        pairUp(desktop, laptop);
        yield* reconcileRounds([desktop, laptop], 2);
        assert.strictEqual(desktop.identity()?.id, LINK);
        assert.strictEqual(laptop.identity()?.id, LINK);
        assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-laptop"]);
        assert.deepStrictEqual(laptop.members(), ["env-desktop", "env-laptop"]);
        assert.strictEqual(yield* stateOf(desktop, laptop), "joined");
        assert.strictEqual(yield* stateOf(laptop, desktop), "joined");
        // Both grants work: the lower id drives, the other never calls.
        assert.isAbove(desktop.sent.length, 0);
        assert.lengthOf(laptop.sent, 0);
        // One before-link point each, and the starter's name everywhere.
        assert.lengthOf(desktop.points, 1);
        assert.lengthOf(laptop.points, 1);
        assert.strictEqual(desktop.current().title, "Percy");
      }),
    );

  it.effect("a grant held only by the higher id has one driver, and the pair links (AC-18)", () =>
    Effect.gen(function* () {
      const { desktop, laptop } = yield* twoSeats("desktop");
      // Desktop issued Laptop an own grant; Laptop issued Desktop none.
      pairUp(desktop, laptop, { aIssuesB: "own", bIssuesA: undefined });
      yield* reconcileRounds([desktop, laptop], 4);
      assert.strictEqual(desktop.identity()?.id, LINK);
      assert.strictEqual(laptop.identity()?.id, LINK);
      assert.strictEqual(yield* stateOf(desktop, laptop), "joined");
      assert.strictEqual(yield* stateOf(laptop, desktop), "joined");
      // Exactly one side called: the one that holds the grant.
      assert.lengthOf(desktop.sent, 0);
      assert.isAbove(laptop.sent.length, 0);
    }),
  );

  it.effect("a pair with no grant either way shows no_grant and calls nobody", () =>
    Effect.gen(function* () {
      const { desktop, laptop } = yield* twoSeats("laptop");
      yield* reconcileRounds([desktop, laptop], 3);
      assert.strictEqual(yield* stateOf(desktop, laptop), "no_grant");
      assert.strictEqual(yield* stateOf(laptop, desktop), "no_grant");
      assert.lengthOf(desktop.sent, 0);
      assert.lengthOf(laptop.sent, 0);
      assert.isUndefined(desktop.identity());
    }),
  );

  it.effect("a team or legacy grant either way is no grant to link with", () =>
    Effect.gen(function* () {
      const { desktop, laptop } = yield* twoSeats("laptop");
      pairUp(desktop, laptop, { aIssuesB: "team", bIssuesA: "legacy" });
      yield* reconcileRounds([desktop, laptop], 4);
      assert.isUndefined(desktop.identity());
      assert.isUndefined(laptop.identity());
      assert.lengthOf(contentSent(desktop), 0);
      assert.lengthOf(contentSent(laptop), 0);
      assert.include(["no_grant", "legacy_grant"], yield* stateOf(desktop, laptop));
      assert.include(["no_grant", "legacy_grant"], yield* stateOf(laptop, desktop));
    }),
  );

  it.effect("both sides thinking the other drives: the silent one is driven after two ticks", () =>
    Effect.gen(function* () {
      const { desktop, laptop } = yield* twoSeats("laptop");
      pairUp(desktop, laptop);
      // Desktop, the lower id, wrongly thinks its grant on Laptop was refused.
      yield* desktop.states.markHeldRefused(laptop.environmentId);
      yield* reconcileRounds([desktop, laptop], 1);
      assert.lengthOf(desktop.sent, 0);
      assert.lengthOf(laptop.sent, 0);
      yield* reconcileRounds([desktop, laptop], 3);
      assert.isAbove(laptop.sent.length, 0);
      assert.strictEqual(desktop.identity()?.id, LINK);
      assert.strictEqual(laptop.identity()?.id, LINK);
    }),
  );

  it.effect("a seat that the owner removed here is refused, and nothing is saved again", () =>
    Effect.gen(function* () {
      const network: Network = new Map();
      const desktop = yield* makeShareSeat(network, "desktop", "Desktop");
      const laptop = yield* makeShareSeat(network, "laptop", "Laptop");
      const tower = yield* makeShareSeat(network, "tower", "Tower");
      desktop.switchOn([laptop.environmentId, tower.environmentId], { start: true });
      laptop.switchOn([desktop.environmentId, tower.environmentId]);
      tower.switchOn([desktop.environmentId, laptop.environmentId]);
      pairUp(desktop, laptop);
      pairUp(desktop, tower);
      pairUp(laptop, tower);
      yield* reconcileRounds([desktop, laptop, tower], 3);
      for (const seat of [desktop, laptop, tower])
        assert.deepStrictEqual(seat.members(), ["env-desktop", "env-laptop", "env-tower"]);
      // The owner removes Tower on Desktop; the switches still list it.
      const identity = desktop.identity()!;
      const binding = desktop.binding()!;
      yield* desktop.projects.update({
        projectId: desktop.projectId,
        commandId: CommandId.make("remove-tower"),
        ownership: {
          mode: "remove-member",
          expectedRevision: desktop.current().workspaceSettings!.revision,
          logicalProject: {
            ...identity,
            members: identity.members.filter((member) => member.environmentId !== "env-tower"),
          },
          coordinatorBinding: {
            ...binding,
            removedMembers: [
              ...(binding.removedMembers ?? []),
              {
                environmentId: tower.environmentId,
                projectId: tower.projectId,
                removedAt: "2026-11-24T00:00:00.000Z",
              },
            ],
          },
        },
      } as any);
      const desktopPoints = desktop.points.length;
      const sentBefore = desktop.sent.filter((entry) => entry.to === tower.environmentId).length;
      yield* reconcileRounds([desktop, laptop, tower], 4);
      // Desktop never admits Tower again and sends it nothing about the assistant.
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-laptop"]);
      const toTower = desktop.sent.filter((entry) => entry.to === tower.environmentId);
      for (const entry of toTower.slice(sentBefore)) assert.isUndefined(entry.request.content);
      for (const call of tower.received.filter((entry) => entry.from === desktop.environmentId))
        if (call.request.state.accepted === false) assert.isUndefined(call.request.content);
      assert.strictEqual(desktop.points.length, desktopPoints);
      const towerState = (yield* desktop.states.states).get(tower.environmentId);
      assert.strictEqual(towerState?.state, "not_confirmed");
      assert.include(towerState?.detail ?? "", "removed");
    }),
  );
});
