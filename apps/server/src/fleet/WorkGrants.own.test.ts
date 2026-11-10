import { describe, expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId } from "@specweave-studio/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { workerClientName } from "./workerGrantMint.ts";
import { grantKindOf, managingCoordinators } from "./workGrantPolicy.ts";
import * as WorkGrants from "./WorkGrants.ts";

/** Ministorm joined this machine as its main machine; Laptop is a colleague's coordinator. */
const MINISTORM = EnvironmentId.make("env-ministorm");
const LAPTOP = EnvironmentId.make("env-laptop");

const session = (environmentId: EnvironmentId, subject: string) => ({
  sessionId: AuthSessionId.make(`session-${environmentId}-${subject}`),
  principal: { kind: "coordinator", environmentId },
  subject,
  client: { label: workerClientName(environmentId), deviceType: "bot" },
});

const layer = WorkGrants.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        setPrincipalRevoked: () => Effect.void,
        listSessions: () =>
          Effect.succeed([
            session(MINISTORM, EnvironmentAuth.FLEET_INVITATION_SUBJECT),
            session(LAPTOP, EnvironmentAuth.MCP_CLIENT_SUBJECT),
          ] as never),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-work-grant-own-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      NodeServices.layer,
    ),
  ),
);

describe("own and team work grants", () => {
  it("is own only for the owner's grant to a coordinator that manages this machine", () => {
    const managers = managingCoordinators(
      [
        session(MINISTORM, EnvironmentAuth.FLEET_INVITATION_SUBJECT),
        session(LAPTOP, EnvironmentAuth.MCP_CLIENT_SUBJECT),
      ] as never,
      EnvironmentAuth.FLEET_INVITATION_SUBJECT,
    );
    expect([...managers]).toEqual([MINISTORM]);
    expect(grantKindOf({ owner: "self", coordinatorEnvironmentId: MINISTORM }, managers)).toBe(
      "own",
    );
    // Marked another person's, a manager's grant stays team.
    expect(grantKindOf({ owner: "other", coordinatorEnvironmentId: MINISTORM }, managers)).toBe(
      "team",
    );
    expect(grantKindOf({ owner: "self", coordinatorEnvironmentId: LAPTOP }, managers)).toBe("team");
  });

  it.effect("turns routines on for a new own grant and leaves a team grant off", () =>
    Effect.gen(function* () {
      const grants = yield* WorkGrants.WorkGrants;
      const own = yield* grants.forCoordinator(MINISTORM);
      expect(own.kind).toBe("own");
      expect(own.routines).toBe(true);
      // A colleague granted after the update (LAPTOP predates it, so it is legacy).
      const team = yield* grants.forCoordinator(EnvironmentId.make("env-colleague"));
      expect(team.kind).toBe("team");
      expect(team.routines).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("upgrades once: the owner's later off sticks", () =>
    Effect.gen(function* () {
      const grants = yield* WorkGrants.WorkGrants;
      yield* grants.forCoordinator(MINISTORM);
      yield* grants.update({ coordinatorEnvironmentId: MINISTORM, routines: false });
      expect((yield* grants.forCoordinator(MINISTORM)).routines).toBe(false);
      const record = (yield* grants.policies).find(
        (policy) => policy.coordinatorEnvironmentId === MINISTORM,
      );
      expect(record?.routinesSettledAt).toBeDefined();
    }).pipe(Effect.provide(layer)),
  );

  it("upgrades an existing scoped grant once and never a legacy one", () => {
    const base: WorkGrants.WorkGrantPolicyRecord = {
      coordinatorEnvironmentId: MINISTORM,
      projects: { kind: "linked" },
      accounts: { kind: "all" },
      owner: "self",
      legacy: false,
      routines: false,
      runtimeCap: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      revokedAt: null,
      interruptAt: null,
      interruptedAt: null,
    };
    const managers = new Set<string>([MINISTORM]);
    const now = "2026-11-10T00:00:00.000Z";
    const upgraded = WorkGrants.withOwnRoutines(base, managers, now);
    expect(upgraded.routines).toBe(true);
    expect(upgraded.routinesSettledAt).toBe(now);
    const turnedOff = { ...upgraded, routines: false };
    expect(WorkGrants.withOwnRoutines(turnedOff, managers, now)).toBe(turnedOff);
    const legacy = { ...base, legacy: true };
    expect(WorkGrants.withOwnRoutines(legacy, managers, now)).toBe(legacy);
    const owner = { ...base, owner: "other" as const };
    expect(WorkGrants.withOwnRoutines(owner, managers, now)).toBe(owner);
  });
});
